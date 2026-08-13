import * as crypto from "crypto";
import * as fs from "fs";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "http";
import * as https from "https";
import { pipeline } from "stream/promises";
import * as tls from "tls";
import type { PeerCertificate } from "tls";

import type { CachePlatform } from "../cache/paths";
import { createAuthHeaders } from "./auth";
import { getCertificateDer } from "./certificate";
import type { PairingPayload } from "./pairing";

export const LAN_EMPTY_SHA256 = crypto.createHash("sha256").digest("hex");
const ENTRY_ROUTE_ID = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 ** 3 + 128 * 1024;

const isBase64Url32 = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
};

export type LanPeerConnection = {
  serverId: string;
  host: string;
  port: number;
  certificatePem: string;
  clientId: string;
  secret: string;
  capabilities: { read: boolean; write: boolean };
};

export type LanPairingOffer = PairingPayload;

export type LanPairingResult = LanPeerConnection & {
  pairingId: string;
  expiresAt: string;
};

export type LanAuthHeaders = {
  "x-elc-client-id": string;
  "x-elc-timestamp": string;
  "x-elc-nonce": string;
  "x-elc-content-sha256": string;
  "x-elc-signature": string;
};

export type LanRequestSigner = (input: {
  clientId: string;
  secret: string;
  method: string;
  pathname: string;
  contentLength: number;
  contentSha256: string;
}) => LanAuthHeaders;

export const signLanRequest: LanRequestSigner = (input) =>
  createAuthHeaders(input);

const singleResponseHeader = (
  response: IncomingMessage,
  name: string
): string | null => {
  const lowerName = name.toLowerCase();
  let count = 0;
  let value: string | null = null;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index]!.toLowerCase() === lowerName) {
      count += 1;
      value = response.rawHeaders[index + 1] ?? null;
    }
  }
  return count === 1 ? value : null;
};

const strictContentLength = (response: IncomingMessage): number => {
  if (
    response.headers["transfer-encoding"] !== undefined ||
    response.headers["content-encoding"] !== undefined
  ) {
    throw new Error("LAN response uses unsupported framing");
  }
  const raw = singleResponseHeader(response, "content-length");
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("LAN response has an invalid content length");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("LAN response content length is unsafe");
  }
  return value;
};

const leafMatches = (
  expectedDer: Buffer,
  expectedPeerId: string,
  certificate: PeerCertificate
): Error | undefined => {
  const actualDer = certificate.raw;
  if (!actualDer || !actualDer.equals(expectedDer)) {
    return new Error("LAN peer certificate pin mismatch");
  }
  const actualPeerId = crypto
    .createHash("sha256")
    .update(actualDer)
    .digest("hex");
  if (actualPeerId !== expectedPeerId) {
    return new Error("LAN peer identity mismatch");
  }
  return undefined;
};

type RawRequestOptions = {
  peer: Pick<
    LanPeerConnection,
    "serverId" | "host" | "port" | "certificatePem"
  >;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  connectTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  overallTimeoutMs?: number;
};

const openPinnedRequest = async (
  options: RawRequestOptions
): Promise<{ request: ClientRequest; response: Promise<IncomingMessage> }> => {
  const overallTimeoutMs = Math.max(1, options.overallTimeoutMs ?? 45_000);
  const deadlineMs = Date.now() + overallTimeoutMs;
  const expectedDer = getCertificateDer(options.peer.certificatePem);
  const socket = tls.connect({
    host: options.peer.host,
    port: options.peer.port,
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    servername: "eas-local-cache",
  });
  let preRequestErrorHandler: ((error: Error) => void) | null = null;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("LAN connection timed out"));
    }, Math.max(1, Math.min(options.connectTimeoutMs ?? 750, deadlineMs - Date.now())));
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };
    preRequestErrorHandler = fail;
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      try {
        const certificate = socket.getPeerCertificate(true);
        const pinError = leafMatches(
          expectedDer,
          options.peer.serverId,
          certificate
        );
        if (pinError) throw pinError;
        const x509 = new crypto.X509Certificate(certificate.raw);
        const now = Date.now();
        if (
          Date.parse(x509.validFrom) > now ||
          Date.parse(x509.validTo) <= now ||
          !x509.verify(x509.publicKey)
        ) {
          throw new Error("LAN peer certificate is invalid or expired");
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error("LAN pin failed"));
      }
    });
  });
  const remainingOverallMs = deadlineMs - Date.now();
  if (remainingOverallMs <= 0) {
    socket.destroy();
    throw new Error("LAN request timed out");
  }
  const controller = new AbortController();
  const overallTimer = setTimeout(
    () => controller.abort(new Error("LAN request timed out")),
    remainingOverallMs
  );
  let resolveResponse!: (response: IncomingMessage) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let request: ClientRequest;
  try {
    request = https.request({
      host: options.peer.host,
      port: options.peer.port,
      method: options.method,
      path: options.pathname,
      headers: options.headers,
      agent: false,
      createConnection: () => socket,
      rejectUnauthorized: false,
      signal: controller.signal,
    });
    if (preRequestErrorHandler) {
      socket.removeListener("error", preRequestErrorHandler);
    }
  } catch (error) {
    clearTimeout(overallTimer);
    socket.destroy();
    throw error;
  }
  request.setTimeout(options.inactivityTimeoutMs ?? 5_000, () => {
    request.destroy(new Error("LAN request became inactive"));
  });
  request.once("response", (response) => {
    const finish = () => {
      clearTimeout(overallTimer);
      socket.destroy();
    };
    response.once("end", finish);
    response.once("close", finish);
    resolveResponse(response);
  });
  request.once("error", (error) => {
    clearTimeout(overallTimer);
    socket.destroy();
    rejectResponse(error);
  });
  return { request, response: responsePromise };
};

const authHeaders = (
  peer: LanPeerConnection,
  signer: LanRequestSigner,
  method: string,
  pathname: string,
  contentLength: number,
  contentSha256: string
): Record<string, string> => ({
  "content-length": String(contentLength),
  ...signer({
    clientId: peer.clientId,
    secret: peer.secret,
    method,
    pathname,
    contentLength,
    contentSha256,
  }),
});

const consumeResponse = async (
  response: IncomingMessage,
  maximumBytes: number
): Promise<Buffer> => {
  const expected = strictContentLength(response);
  if (expected > maximumBytes)
    throw new Error("LAN response exceeds its limit");
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    received += chunk.length;
    if (received > expected || received > maximumBytes) {
      throw new Error("LAN response exceeds its declared length");
    }
    chunks.push(chunk);
  }
  if (received !== expected) throw new Error("LAN response is truncated");
  return Buffer.concat(chunks, received);
};

const assertEntryIdentity = (
  platform: CachePlatform,
  entryId: string
): string => {
  if (!ENTRY_ROUTE_ID.test(entryId)) throw new Error("Invalid LAN entry ID");
  return `/v1/entries/${platform}/${entryId}`;
};

export const pingLanPeer = async (
  peer: LanPeerConnection,
  options: { signer?: LanRequestSigner; timeoutMs?: number } = {}
): Promise<{
  protocolVersion: 1;
  serverId: string;
  capabilities: string[];
}> => {
  const pathname = "/v1/ping";
  const { request, response } = await openPinnedRequest({
    peer,
    method: "GET",
    pathname,
    headers: authHeaders(
      peer,
      options.signer ?? signLanRequest,
      "GET",
      pathname,
      0,
      LAN_EMPTY_SHA256
    ),
    overallTimeoutMs: options.timeoutMs ?? 750,
  });
  request.end();
  const incoming = await response;
  const bytes = await consumeResponse(incoming, MAX_JSON_BYTES);
  if (incoming.statusCode !== 200) throw new Error("LAN peer rejected ping");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocolVersion" in value) ||
    value.protocolVersion !== 1 ||
    !("serverId" in value) ||
    value.serverId !== peer.serverId ||
    !("capabilities" in value) ||
    !Array.isArray(value.capabilities)
  ) {
    throw new Error("LAN ping response is malformed");
  }
  return value as {
    protocolVersion: 1;
    serverId: string;
    capabilities: string[];
  };
};

export const headLanEntry = async (
  peer: LanPeerConnection,
  platform: CachePlatform,
  entryId: string,
  options: { signer?: LanRequestSigner; timeoutMs?: number } = {}
): Promise<{ sizeBytes: number; sha256: string } | null> => {
  const pathname = assertEntryIdentity(platform, entryId);
  const { request, response } = await openPinnedRequest({
    peer,
    method: "HEAD",
    pathname,
    headers: authHeaders(
      peer,
      options.signer ?? signLanRequest,
      "HEAD",
      pathname,
      0,
      LAN_EMPTY_SHA256
    ),
    overallTimeoutMs: options.timeoutMs ?? 750,
  });
  request.end();
  const incoming = await response;
  if (incoming.statusCode === 404) {
    await consumeResponse(incoming, 0);
    return null;
  }
  if (incoming.statusCode !== 200) {
    incoming.destroy();
    throw new Error("LAN peer rejected entry probe");
  }
  const sizeBytes = strictContentLength(incoming);
  const sha256 = singleResponseHeader(incoming, "x-elc-content-sha256");
  incoming.resume();
  if (
    sizeBytes <= 0 ||
    sizeBytes > MAX_ENTRY_BYTES ||
    !sha256 ||
    !SHA256.test(sha256)
  ) {
    throw new Error("LAN entry probe response is malformed");
  }
  return { sizeBytes, sha256 };
};

export const fetchLanEntry = async (
  peer: LanPeerConnection,
  platform: CachePlatform,
  entryId: string,
  destination: string,
  options: { signer?: LanRequestSigner; timeoutMs?: number } = {}
): Promise<{ sizeBytes: number; sha256: string }> => {
  const pathname = assertEntryIdentity(platform, entryId);
  const { request, response } = await openPinnedRequest({
    peer,
    method: "GET",
    pathname,
    headers: authHeaders(
      peer,
      options.signer ?? signLanRequest,
      "GET",
      pathname,
      0,
      LAN_EMPTY_SHA256
    ),
    overallTimeoutMs: options.timeoutMs ?? 45_000,
  });
  request.end();
  const incoming = await response;
  if (incoming.statusCode !== 200) {
    incoming.destroy();
    throw new Error("LAN peer did not provide the requested entry");
  }
  const sizeBytes = strictContentLength(incoming);
  const expectedDigest = singleResponseHeader(incoming, "x-elc-content-sha256");
  if (
    sizeBytes <= 0 ||
    sizeBytes > MAX_ENTRY_BYTES ||
    !expectedDigest ||
    !SHA256.test(expectedDigest)
  ) {
    incoming.destroy();
    throw new Error("LAN entry response is malformed");
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
  incoming.on("data", (rawChunk: Buffer) => {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    received += chunk.length;
    if (received > sizeBytes || received > MAX_ENTRY_BYTES) {
      incoming.destroy(new Error("LAN entry exceeds its declared length"));
      return;
    }
    hash.update(chunk);
  });
  try {
    await pipeline(incoming, output);
    if (received !== sizeBytes || hash.digest("hex") !== expectedDigest) {
      throw new Error("LAN entry transfer integrity mismatch");
    }
    return { sizeBytes, sha256: expectedDigest };
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
};

const openHashedFile = (
  filename: string
): { descriptor: number; sizeBytes: number; sha256: string } => {
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ENTRY_BYTES) {
      throw new Error("LAN package is not a bounded regular file");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let read = 0;
    while (read < stats.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stats.size - read),
        read
      );
      if (count === 0) throw new Error("LAN package changed while hashing");
      hash.update(buffer.subarray(0, count));
      read += count;
    }
    return {
      descriptor,
      sizeBytes: stats.size,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
};

export const putLanEntry = async (
  peer: LanPeerConnection,
  platform: CachePlatform,
  entryId: string,
  packagePath: string,
  options: { signer?: LanRequestSigner; timeoutMs?: number } = {}
): Promise<"created" | "existing" | "conflict"> => {
  const pathname = assertEntryIdentity(platform, entryId);
  const packageInfo = openHashedFile(packagePath);
  let streamOwnsDescriptor = false;
  try {
    const { request, response } = await openPinnedRequest({
      peer,
      method: "PUT",
      pathname,
      headers: {
        ...authHeaders(
          peer,
          options.signer ?? signLanRequest,
          "PUT",
          pathname,
          packageInfo.sizeBytes,
          packageInfo.sha256
        ),
        "content-type": "application/vnd.eas-local-cache.wire",
        "if-none-match": "*",
      },
      overallTimeoutMs: options.timeoutMs ?? 30_000,
    });
    const packageStream = fs.createReadStream("", {
      fd: packageInfo.descriptor,
      autoClose: true,
    });
    streamOwnsDescriptor = true;
    const responseOutcome = response.then(
      (incoming) => ({ incoming, error: null }),
      (error: Error) => ({ incoming: null, error })
    );
    try {
      await pipeline(packageStream, request);
    } catch (error) {
      request.destroy();
      await responseOutcome;
      throw error;
    }
    const outcome = await responseOutcome;
    if (outcome.error) throw outcome.error;
    const incoming = outcome.incoming;
    if (!incoming) throw new Error("LAN peer returned no upload response");
    await consumeResponse(incoming, 0);
    if (incoming.statusCode === 201) return "created";
    if (incoming.statusCode === 204) return "existing";
    if (incoming.statusCode === 409) return "conflict";
    throw new Error("LAN peer rejected entry upload");
  } finally {
    if (!streamOwnsDescriptor) fs.closeSync(packageInfo.descriptor);
  }
};

const strictPairResponse = (
  value: unknown
): {
  pairingId: string;
  serverId: string;
  secret: string;
  capabilities: { read: boolean; write: boolean };
  expiresAt: string;
} => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "capabilities,expiresAt,pairingId,secret,serverId" ||
    !("pairingId" in value) ||
    typeof value.pairingId !== "string" ||
    !/^[A-Za-z0-9_-]{22,43}$/.test(value.pairingId) ||
    !("serverId" in value) ||
    typeof value.serverId !== "string" ||
    !SHA256.test(value.serverId) ||
    !("secret" in value) ||
    typeof value.secret !== "string" ||
    !isBase64Url32(value.secret) ||
    !("capabilities" in value) ||
    typeof value.capabilities !== "object" ||
    value.capabilities === null ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  ) {
    throw new Error("LAN pairing response is malformed");
  }
  const capabilities = value.capabilities as Record<string, unknown>;
  if (
    Object.keys(capabilities).sort().join(",") !== "read,write" ||
    typeof capabilities.read !== "boolean" ||
    typeof capabilities.write !== "boolean"
  ) {
    throw new Error("LAN pairing capabilities are malformed");
  }
  return value as ReturnType<typeof strictPairResponse>;
};

export const pairWithLanServer = async (
  offer: LanPairingOffer,
  clientId: string,
  options: {
    signer?: LanRequestSigner;
    timeoutMs?: number;
    beforeAcknowledge?: (peer: LanPeerConnection) => void | Promise<void>;
  } = {}
): Promise<LanPairingResult> => {
  if (
    offer.version !== 1 ||
    !isBase64Url32(clientId) ||
    !isBase64Url32(offer.capability) ||
    !SHA256.test(offer.serverId) ||
    typeof offer.host !== "string" ||
    offer.host.length === 0 ||
    offer.host.length > 253 ||
    !Number.isInteger(offer.port) ||
    offer.port < 1 ||
    offer.port > 65_535 ||
    !Number.isFinite(Date.parse(offer.expiresAt)) ||
    Date.parse(offer.expiresAt) <= Date.now()
  ) {
    throw new Error("LAN pairing offer is invalid or expired");
  }
  const peerIdentity = {
    host: offer.host,
    port: offer.port,
    serverId: offer.serverId,
    certificatePem: offer.certificatePem,
  };
  const body = Buffer.from(
    `${JSON.stringify({ clientId, capability: offer.capability })}\n`,
    "utf8"
  );
  const { request, response } = await openPinnedRequest({
    peer: peerIdentity,
    method: "POST",
    pathname: "/v1/pair",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/json",
    },
    overallTimeoutMs: options.timeoutMs ?? 5_000,
  });
  request.end(body);
  const incoming = await response;
  const responseBytes = await consumeResponse(incoming, MAX_JSON_BYTES);
  if (incoming.statusCode !== 200) throw new Error("LAN pairing was rejected");
  const paired = strictPairResponse(JSON.parse(responseBytes.toString("utf8")));
  if (paired.serverId !== offer.serverId) {
    throw new Error("LAN pairing identity changed");
  }
  if (
    Date.parse(paired.expiresAt) <= Date.now() ||
    Date.parse(paired.expiresAt) > Date.parse(offer.expiresAt)
  ) {
    throw new Error("LAN pairing response has an invalid lifetime");
  }
  const peer: LanPeerConnection = {
    ...peerIdentity,
    clientId,
    secret: paired.secret,
    capabilities: paired.capabilities,
  };
  await options.beforeAcknowledge?.(peer);
  const ackBody = Buffer.from(
    `${JSON.stringify({ pairingId: paired.pairingId })}\n`,
    "utf8"
  );
  const ackDigest = crypto.createHash("sha256").update(ackBody).digest("hex");
  const ack = await openPinnedRequest({
    peer,
    method: "POST",
    pathname: "/v1/pair/ack",
    headers: {
      ...authHeaders(
        peer,
        options.signer ?? signLanRequest,
        "POST",
        "/v1/pair/ack",
        ackBody.length,
        ackDigest
      ),
      "content-type": "application/json",
    },
    overallTimeoutMs: options.timeoutMs ?? 5_000,
  });
  ack.request.end(ackBody);
  const ackResponse = await ack.response;
  const ackBytes = await consumeResponse(ackResponse, MAX_JSON_BYTES);
  if (ackResponse.statusCode !== 204 || ackBytes.length !== 0) {
    throw new Error("LAN pairing acknowledgement failed");
  }
  return {
    ...peer,
    pairingId: paired.pairingId,
    expiresAt: paired.expiresAt,
  };
};

export const responseHeadersForTesting = (
  response: IncomingMessage
): IncomingHttpHeaders => response.headers;
