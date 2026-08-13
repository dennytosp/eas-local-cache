import * as crypto from "crypto";
import * as fs from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { pipeline } from "stream/promises";

import type { LanAuthenticationRequest } from "./server-types";

const SHA256 = /^[a-f0-9]{64}$/;

export const singleHeader = (
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

export const parseContentLength = (request: IncomingMessage): number | null => {
  const value = singleHeader(request, "content-length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const sendBuffer = (
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

export const sendJson = (
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

export const sendEmpty = (
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

export const rejectRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  status: number
): void => {
  request.resume();
  sendEmpty(response, status);
};

export const ensureIncomingDirectory = (directory: string): void => {
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

export const ensureTransferLocksDirectory = (directory: string): void => {
  ensureIncomingDirectory(directory);
};

export const readBody = async (
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

export const spoolBody = async (
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

export class LanOperationTimeoutError extends Error {
  constructor() {
    super("LAN server operation exceeded its deadline");
  }
}

export const awaitBeforeDeadline = async <T>(
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

export const isStrictRequestTarget = (target: string): boolean =>
  target.startsWith("/") &&
  !target.includes("?") &&
  !target.includes("#") &&
  !target.includes("%") &&
  !target.includes("\\") &&
  !target.includes("//");

export const framingIsSafe = (request: IncomingMessage): boolean =>
  request.httpVersionMajor === 1 &&
  request.httpVersionMinor === 1 &&
  request.headers["transfer-encoding"] === undefined &&
  request.headers["content-encoding"] === undefined &&
  request.headers.expect === undefined &&
  parseContentLength(request) !== null;

export const authFields = (
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
