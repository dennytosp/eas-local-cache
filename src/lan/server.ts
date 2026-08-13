import * as crypto from "crypto";
import * as fs from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";

import {
  acquireEntryLock,
  releaseEntryLock,
  type EntryLock,
} from "../cache/lock";
import type { CachePlatform } from "../cache/paths";
import { NonceReplayGuard, verifyAuthHeaders } from "./auth";
import type { LanAuthorizedClient } from "./types";

const EMPTY_SHA256 = crypto.createHash("sha256").digest("hex");
const MAX_PAIR_BODY_BYTES = 16 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 ** 3 + 128 * 1024;
const MAX_OPERATION_TIMEOUT_MS = 45_000;
const ENTRY_ROUTE = /^\/v1\/entries\/(ios|android)\/([a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type LanCapability = "read" | "write";

export type LanAuthenticatedClient = {
  clientId: string;
  capabilities: readonly LanCapability[];
};

export type LanAuthenticationRequest = {
  clientId: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
  signature: string;
  contentLength: number;
  method: string;
  pathname: string;
  allowPendingPairing: boolean;
};

export type PreparedLanEntry = {
  packagePath: string;
  sizeBytes: number;
  sha256: string;
  cleanup?: () => void | Promise<void>;
};

export type LanServerOptions = {
  host?: string;
  port?: number;
  certificatePem: string;
  privateKeyPem: string;
  serverId: string;
  allowWrite?: boolean;
  incomingDirectory: string;
  transferLocksRoot?: string;
  authenticate: (
    request: LanAuthenticationRequest
  ) => LanAuthenticatedClient | null | Promise<LanAuthenticatedClient | null>;
  pair?: (
    body: unknown,
    context: { remoteAddress: string }
  ) => unknown | Promise<unknown>;
  acknowledgePairing?: (
    pairingId: string,
    client: LanAuthenticatedClient
  ) => unknown | Promise<unknown>;
  prepareEntry: (
    platform: CachePlatform,
    entryId: string,
    deadlineMs: number
  ) => PreparedLanEntry | null | Promise<PreparedLanEntry | null>;
  importEntry: (
    platform: CachePlatform,
    entryId: string,
    packagePath: string,
    transferLock: EntryLock | undefined,
    deadlineMs: number
  ) =>
    | "created"
    | "existing"
    | "conflict"
    | Promise<"created" | "existing" | "conflict">;
  globalTransferLimit?: number;
  perClientTransferLimit?: number;
  requestInactivityMs?: number;
  operationTimeoutMs?: number;
};

export const createLanServerAuthenticator = (options: {
  findClient: (
    clientId: string
  ) => LanAuthorizedClient | null | Promise<LanAuthorizedClient | null>;
  allowPendingClient?: (
    client: LanAuthorizedClient,
    request: LanAuthenticationRequest
  ) => boolean | Promise<boolean>;
  replayGuard?: NonceReplayGuard;
}): LanServerOptions["authenticate"] => {
  const replayGuard = options.replayGuard ?? new NonceReplayGuard();
  return async (request) => {
    const client = await options.findClient(request.clientId);
    if (!client) return null;
    const statusAllowed =
      client.status === "active" ||
      (request.allowPendingPairing &&
        client.status === "pending" &&
        options.allowPendingClient &&
        (await options.allowPendingClient(client, request)));
    if (!statusAllowed) return null;
    try {
      verifyAuthHeaders({
        headers: {
          clientId: request.clientId,
          timestamp: request.timestamp,
          nonce: request.nonce,
          contentSha256: request.contentSha256,
          signature: request.signature,
        },
        secret: client.secret,
        method: request.method,
        pathname: request.pathname,
        contentLength: request.contentLength,
        replayGuard,
      });
      return {
        clientId: client.clientId,
        capabilities: [
          ...(client.capabilities.read ? (["read"] as const) : []),
          ...(client.capabilities.write ? (["write"] as const) : []),
        ],
      };
    } catch {
      return null;
    }
  };
};

export type LanServerHandle = {
  host: string;
  port: number;
  url: string;
  close: (drainMs?: number) => Promise<void>;
};

const singleHeader = (
  request: IncomingMessage,
  name: string
): string | null => {
  const lowerName = name.toLowerCase();
  let count = 0;
  let value: string | null = null;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === lowerName) {
      count += 1;
      value = request.rawHeaders[index + 1] ?? null;
    }
  }
  return count === 1 ? value : null;
};

const parseContentLength = (request: IncomingMessage): number | null => {
  const value = singleHeader(request, "content-length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const sendBuffer = (
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(body.length),
    "content-type": contentType,
    ...headers,
  });
  response.end(body);
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown
): void =>
  sendBuffer(
    response,
    status,
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    "application/json"
  );

const sendEmpty = (
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {}
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": "0",
    ...headers,
  });
  response.end();
};

const rejectRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  status: number
): void => {
  request.resume();
  sendEmpty(response, status);
};

const ensureIncomingDirectory = (directory: string): void => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("LAN incoming path must be a real directory");
  }
  if (process.platform !== "win32") {
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error("LAN incoming path has a different owner");
    }
    fs.chmodSync(directory, 0o700);
  }
};

const ensureTransferLocksDirectory = (directory: string): void => {
  ensureIncomingDirectory(directory);
};

const readBody = async (
  request: IncomingMessage,
  expectedBytes: number,
  maximumBytes: number
): Promise<{ bytes: Buffer; digest: string }> => {
  if (expectedBytes > maximumBytes) throw new Error("body-too-large");
  const chunks: Buffer[] = [];
  const hash = crypto.createHash("sha256");
  let received = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    received += chunk.length;
    if (received > expectedBytes || received > maximumBytes) {
      throw new Error("body-overflow");
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (received !== expectedBytes) throw new Error("body-truncated");
  return { bytes: Buffer.concat(chunks, received), digest: hash.digest("hex") };
};

const spoolBody = async (
  request: IncomingMessage,
  expectedBytes: number,
  maximumBytes: number,
  destination: string,
  deadlineMs: number
): Promise<string> => {
  if (Date.now() >= deadlineMs) throw new LanOperationTimeoutError();
  if (expectedBytes <= 0 || expectedBytes > maximumBytes) {
    throw new Error("body-size-invalid");
  }
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600
  );
  const output = fs.createWriteStream("", { fd: descriptor, autoClose: true });
  const hash = crypto.createHash("sha256");
  let received = 0;
  request.on("data", (rawChunk: Buffer) => {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    received += chunk.length;
    if (received > expectedBytes || received > maximumBytes) {
      request.destroy(new Error("body-overflow"));
      return;
    }
    hash.update(chunk);
  });
  const timeout = setTimeout(() => {
    request.destroy(new LanOperationTimeoutError());
  }, Math.max(1, deadlineMs - Date.now()));
  try {
    await pipeline(request, output);
  } finally {
    clearTimeout(timeout);
  }
  if (received !== expectedBytes) throw new Error("body-truncated");
  return hash.digest("hex");
};

class LanOperationTimeoutError extends Error {
  constructor() {
    super("LAN server operation exceeded its deadline");
  }
}

const awaitBeforeDeadline = async <T>(
  operation: Promise<T>,
  deadlineMs: number
): Promise<T> => {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new LanOperationTimeoutError();
  let timeout: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new LanOperationTimeoutError()),
          remainingMs
        );
      }),
    ]);
    if (Date.now() >= deadlineMs) throw new LanOperationTimeoutError();
    return value;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const isStrictRequestTarget = (target: string): boolean =>
  target.startsWith("/") &&
  !target.includes("?") &&
  !target.includes("#") &&
  !target.includes("%") &&
  !target.includes("\\") &&
  !target.includes("//");

const framingIsSafe = (request: IncomingMessage): boolean =>
  request.httpVersionMajor === 1 &&
  request.httpVersionMinor === 1 &&
  request.headers["transfer-encoding"] === undefined &&
  request.headers["content-encoding"] === undefined &&
  request.headers.expect === undefined &&
  parseContentLength(request) !== null;

const authFields = (
  request: IncomingMessage,
  contentLength: number,
  pathname: string,
  allowPendingPairing: boolean
): LanAuthenticationRequest | null => {
  const clientId = singleHeader(request, "x-elc-client-id");
  const timestamp = singleHeader(request, "x-elc-timestamp");
  const nonce = singleHeader(request, "x-elc-nonce");
  const contentSha256 = singleHeader(request, "x-elc-content-sha256");
  const signature = singleHeader(request, "x-elc-signature");
  if (
    !clientId ||
    !timestamp ||
    !nonce ||
    !contentSha256 ||
    !signature ||
    !SHA256.test(contentSha256)
  ) {
    return null;
  }
  return {
    clientId,
    timestamp,
    nonce,
    contentSha256,
    signature,
    contentLength,
    method: request.method ?? "",
    pathname,
    allowPendingPairing,
  };
};

export const startLanServer = async (
  options: LanServerOptions
): Promise<LanServerHandle> => {
  ensureIncomingDirectory(options.incomingDirectory);
  if (options.transferLocksRoot) {
    ensureTransferLocksDirectory(options.transferLocksRoot);
  }
  const activeByClient = new Map<string, number>();
  const pairAttempts = new Map<string, { startMs: number; count: number }>();
  const sockets = new Set<import("tls").TLSSocket>();
  let globalActive = 0;
  let closing = false;
  const globalLimit = options.globalTransferLimit ?? 8;
  const perClientLimit = options.perClientTransferLimit ?? 4;
  const inactivityMs = options.requestInactivityMs ?? 5_000;
  const operationTimeoutMs = Math.max(
    1,
    Math.min(
      options.operationTimeoutMs ?? MAX_OPERATION_TIMEOUT_MS,
      MAX_OPERATION_TIMEOUT_MS
    )
  );
  let closePromise: Promise<void> | null = null;

  const server = https.createServer(
    {
      cert: options.certificatePem,
      key: options.privateKeyPem,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      maxHeaderSize: 16 * 1024,
      requestTimeout: inactivityMs,
      headersTimeout: inactivityMs,
      keepAliveTimeout: 1,
    },
    async (request, response) => {
      const requestDeadlineMs = Date.now() + operationTimeoutMs;
      response.on("error", () => {});
      try {
        if (closing || !request.url || !framingIsSafe(request)) {
          rejectRequest(request, response, closing ? 503 : 400);
          return;
        }
        const pathname = request.url;
        if (!isStrictRequestTarget(pathname)) {
          rejectRequest(request, response, 400);
          return;
        }
        const contentLength = parseContentLength(request)!;

        if (request.method === "POST" && pathname === "/v1/pair") {
          if (!options.pair || contentLength > MAX_PAIR_BODY_BYTES) {
            rejectRequest(request, response, options.pair ? 413 : 404);
            return;
          }
          const remoteAddress = request.socket.remoteAddress ?? "unknown";
          const now = Date.now();
          if (pairAttempts.size >= 1_024) {
            for (const [address, record] of pairAttempts) {
              if (now - record.startMs >= 60_000) pairAttempts.delete(address);
            }
            if (
              pairAttempts.size >= 1_024 &&
              !pairAttempts.has(remoteAddress)
            ) {
              rejectRequest(request, response, 429);
              return;
            }
          }
          const current = pairAttempts.get(remoteAddress);
          const attempts =
            !current || now - current.startMs >= 60_000
              ? { startMs: now, count: 0 }
              : current;
          attempts.count += 1;
          pairAttempts.set(remoteAddress, attempts);
          if (attempts.count > 20) {
            rejectRequest(request, response, 429);
            return;
          }
          const body = await readBody(
            request,
            contentLength,
            MAX_PAIR_BODY_BYTES
          );
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.bytes.toString("utf8"));
          } catch {
            sendEmpty(response, 400);
            return;
          }
          if (
            singleHeader(request, "content-type") !== "application/json" ||
            body.bytes.toString("utf8") !== `${JSON.stringify(parsed)}\n`
          ) {
            sendEmpty(response, 400);
            return;
          }
          const result = await options.pair(parsed, { remoteAddress });
          sendJson(response, 200, result);
          return;
        }

        const fields = authFields(
          request,
          contentLength,
          pathname,
          pathname === "/v1/pair/ack"
        );
        const client = fields ? await options.authenticate(fields) : null;
        if (!client) {
          rejectRequest(request, response, 401);
          return;
        }

        if (request.method === "GET" && pathname === "/v1/ping") {
          if (
            contentLength !== 0 ||
            fields!.contentSha256 !== EMPTY_SHA256 ||
            !client.capabilities.includes("read")
          ) {
            rejectRequest(request, response, 403);
            return;
          }
          sendJson(response, 200, {
            protocolVersion: 1,
            serverId: options.serverId,
            capabilities: options.allowWrite ? ["read", "write"] : ["read"],
          });
          return;
        }

        if (request.method === "POST" && pathname === "/v1/pair/ack") {
          if (
            !options.acknowledgePairing ||
            contentLength > MAX_PAIR_BODY_BYTES
          ) {
            rejectRequest(request, response, 404);
            return;
          }
          const body = await readBody(
            request,
            contentLength,
            MAX_PAIR_BODY_BYTES
          );
          if (body.digest !== fields!.contentSha256) {
            sendEmpty(response, 400);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.bytes.toString("utf8"));
          } catch {
            sendEmpty(response, 400);
            return;
          }
          if (
            singleHeader(request, "content-type") !== "application/json" ||
            body.bytes.toString("utf8") !== `${JSON.stringify(parsed)}\n`
          ) {
            sendEmpty(response, 400);
            return;
          }
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 1 ||
            !("pairingId" in parsed) ||
            typeof parsed.pairingId !== "string"
          ) {
            sendEmpty(response, 400);
            return;
          }
          await options.acknowledgePairing(parsed.pairingId, client);
          sendEmpty(response, 204);
          return;
        }

        const match = ENTRY_ROUTE.exec(pathname);
        if (!match) {
          rejectRequest(request, response, 404);
          return;
        }
        const platform = match[1] as CachePlatform;
        const entryId = match[2]!;
        const isRead = request.method === "HEAD" || request.method === "GET";
        const isWrite = request.method === "PUT";
        if (!isRead && !isWrite) {
          rejectRequest(request, response, 405);
          return;
        }
        if (
          (isRead && !client.capabilities.includes("read")) ||
          (isWrite &&
            (!options.allowWrite || !client.capabilities.includes("write")))
        ) {
          rejectRequest(request, response, 403);
          return;
        }
        if (
          (isRead &&
            (contentLength !== 0 ||
              fields!.contentSha256 !== EMPTY_SHA256 ||
              request.headers.range !== undefined)) ||
          (isWrite &&
            (contentLength <= 0 ||
              contentLength > MAX_ENTRY_BYTES ||
              singleHeader(request, "if-none-match") !== "*" ||
              singleHeader(request, "content-type") !==
                "application/vnd.eas-local-cache.wire"))
        ) {
          rejectRequest(request, response, 400);
          return;
        }

        const clientActive = activeByClient.get(client.clientId) ?? 0;
        if (globalActive >= globalLimit || clientActive >= perClientLimit) {
          rejectRequest(request, response, 429);
          return;
        }
        globalActive += 1;
        activeByClient.set(client.clientId, clientActive + 1);
        let finishAfter: Promise<void> = Promise.resolve();
        const transferLock = options.transferLocksRoot
          ? await acquireEntryLock(options.transferLocksRoot, entryId, {
              maxWaitMs: Math.max(
                1,
                Math.min(inactivityMs, requestDeadlineMs - Date.now())
              ),
              retryIntervalMs: 25,
            })
          : null;
        if (options.transferLocksRoot && !transferLock) {
          globalActive -= 1;
          const remaining = (activeByClient.get(client.clientId) ?? 1) - 1;
          if (remaining <= 0) activeByClient.delete(client.clientId);
          else activeByClient.set(client.clientId, remaining);
          rejectRequest(request, response, 503);
          return;
        }
        try {
          if (isWrite) {
            const incomingPath = path.join(
              options.incomingDirectory,
              `${entryId}-${crypto.randomUUID()}.wire`
            );
            let removeIncomingImmediately = true;
            try {
              const digest = await spoolBody(
                request,
                contentLength,
                MAX_ENTRY_BYTES,
                incomingPath,
                requestDeadlineMs
              );
              if (digest !== fields!.contentSha256) {
                sendEmpty(response, 400);
                return;
              }
              const importOperation = Promise.resolve().then(() =>
                options.importEntry(
                  platform,
                  entryId,
                  incomingPath,
                  transferLock ?? undefined,
                  requestDeadlineMs
                )
              );
              let outcome: "created" | "existing" | "conflict";
              try {
                outcome = await awaitBeforeDeadline(
                  importOperation,
                  requestDeadlineMs
                );
              } catch (error) {
                if (error instanceof LanOperationTimeoutError) {
                  removeIncomingImmediately = false;
                  finishAfter = importOperation.then(
                    () => fs.rmSync(incomingPath, { force: true }),
                    () => fs.rmSync(incomingPath, { force: true })
                  );
                }
                throw error;
              }
              if (Date.now() >= requestDeadlineMs) {
                throw new LanOperationTimeoutError();
              }
              sendEmpty(
                response,
                outcome === "created" ? 201 : outcome === "existing" ? 204 : 409
              );
            } finally {
              if (removeIncomingImmediately) {
                fs.rmSync(incomingPath, { force: true });
              }
            }
            return;
          }

          const prepareOperation = Promise.resolve().then(() =>
            options.prepareEntry(platform, entryId, requestDeadlineMs)
          );
          let prepared: PreparedLanEntry | null;
          try {
            prepared = await awaitBeforeDeadline(
              prepareOperation,
              requestDeadlineMs
            );
          } catch (error) {
            if (error instanceof LanOperationTimeoutError) {
              finishAfter = prepareOperation.then(
                async (latePrepared) => {
                  await latePrepared?.cleanup?.();
                },
                () => {}
              );
            }
            throw error;
          }
          if (!prepared) {
            rejectRequest(request, response, 404);
            return;
          }
          try {
            if (Date.now() >= requestDeadlineMs) {
              throw new LanOperationTimeoutError();
            }
            if (
              !Number.isSafeInteger(prepared.sizeBytes) ||
              prepared.sizeBytes <= 0 ||
              prepared.sizeBytes > MAX_ENTRY_BYTES ||
              !SHA256.test(prepared.sha256)
            ) {
              sendEmpty(response, 500);
              return;
            }
            const headers = {
              "content-length": String(prepared.sizeBytes),
              "content-type": "application/vnd.eas-local-cache.wire",
              "x-elc-content-sha256": prepared.sha256,
            };
            if (request.method === "HEAD") {
              response.writeHead(200, {
                "cache-control": "no-store",
                connection: "close",
                ...headers,
              });
              response.end();
              return;
            }
            response.writeHead(200, {
              "cache-control": "no-store",
              connection: "close",
              ...headers,
            });
            const descriptor = fs.openSync(
              prepared.packagePath,
              fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
            );
            const stats = fs.fstatSync(descriptor);
            if (!stats.isFile() || stats.size !== prepared.sizeBytes) {
              fs.closeSync(descriptor);
              response.destroy(new Error("Prepared LAN package changed"));
              return;
            }
            const source = fs.createReadStream("", {
              fd: descriptor,
              autoClose: true,
            });
            const timeout = setTimeout(() => {
              source.destroy(new LanOperationTimeoutError());
              response.destroy(new LanOperationTimeoutError());
            }, Math.max(1, requestDeadlineMs - Date.now()));
            try {
              await pipeline(source, response);
            } finally {
              clearTimeout(timeout);
            }
          } finally {
            await prepared.cleanup?.();
          }
        } finally {
          const finishTransfer = (): void => {
            if (transferLock) releaseEntryLock(transferLock);
            globalActive -= 1;
            const remaining = (activeByClient.get(client.clientId) ?? 1) - 1;
            if (remaining <= 0) activeByClient.delete(client.clientId);
            else activeByClient.set(client.clientId, remaining);
          };
          void finishAfter.then(finishTransfer, finishTransfer);
        }
      } catch (error) {
        if (!response.headersSent) {
          sendEmpty(
            response,
            error instanceof LanOperationTimeoutError ? 503 : 500
          );
        } else response.destroy();
      }
    }
  );

  server.on("secureConnection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("LAN server did not bind a TCP address");
  }

  return {
    host: address.address,
    port: address.port,
    url: `https://${
      address.family === "IPv6" ? `[${address.address}]` : address.address
    }:${address.port}`,
    close: (drainMs = 2_000) => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve())
        );
        const deadline = Date.now() + Math.max(0, drainMs);
        while (globalActive > 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await closed;
      })();
      return closePromise;
    },
  };
};
