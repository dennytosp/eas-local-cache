import * as crypto from "crypto";

export const EMPTY_SHA256 = crypto.createHash("sha256").digest("hex");

export const LAN_AUTH_HEADER_NAMES = {
  clientId: "x-elc-client-id",
  timestamp: "x-elc-timestamp",
  nonce: "x-elc-nonce",
  contentSha256: "x-elc-content-sha256",
  signature: "x-elc-signature",
} as const;

export type LanAuthHeaderValues = {
  clientId: string;
  timestamp: string;
  nonce: string;
  contentSha256: string;
  signature: string;
};

export type LanAuthHeaders = Record<
  (typeof LAN_AUTH_HEADER_NAMES)[keyof typeof LAN_AUTH_HEADER_NAMES],
  string
>;

const assertClientId = (clientId: string): void => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(clientId)) {
    throw new Error("Invalid LAN authentication");
  }
};

const assertMethod = (method: string): void => {
  if (!/^[A-Z]{3,7}$/.test(method)) {
    throw new Error("Invalid LAN authentication");
  }
};

const assertPathname = (pathname: string): void => {
  if (
    pathname.length === 0 ||
    pathname.length > 2_048 ||
    !pathname.startsWith("/") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    [...pathname].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    pathname.includes("%")
  ) {
    throw new Error("Invalid LAN authentication");
  }
};

const assertContent = (contentLength: number, contentSha256: string): void => {
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    !/^[a-f0-9]{64}$/.test(contentSha256)
  ) {
    throw new Error("Invalid LAN authentication");
  }
};

const decodeSecret = (secret: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("Invalid LAN authentication");
  }
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== secret) {
    throw new Error("Invalid LAN authentication");
  }
  return decoded;
};

export const canonicalizeAuthInput = (input: {
  clientId: string;
  method: string;
  pathname: string;
  timestamp: string | number;
  nonce: string;
  contentLength: number;
  contentSha256: string;
}): string => {
  assertClientId(input.clientId);
  assertMethod(input.method);
  assertPathname(input.pathname);
  const timestamp = String(input.timestamp);
  if (!/^(?:0|[1-9][0-9]{0,12})$/.test(timestamp)) {
    throw new Error("Invalid LAN authentication");
  }
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.nonce)) {
    throw new Error("Invalid LAN authentication");
  }
  assertContent(input.contentLength, input.contentSha256);

  return [
    "ELCAUTH1",
    input.clientId,
    input.method,
    input.pathname,
    timestamp,
    input.nonce,
    String(input.contentLength),
    input.contentSha256,
  ].join("\n");
};

const signCanonicalInput = (canonical: string, secret: string): string =>
  crypto
    .createHmac("sha256", decodeSecret(secret))
    .update(canonical)
    .digest("hex");

export const createAuthHeaders = (input: {
  clientId: string;
  secret: string;
  method: string;
  pathname: string;
  contentLength: number;
  contentSha256: string;
  timestamp?: number;
  nonce?: string;
}): LanAuthHeaders => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000);
  const nonce = input.nonce ?? crypto.randomBytes(16).toString("base64url");
  const canonical = canonicalizeAuthInput({ ...input, timestamp, nonce });
  const signature = signCanonicalInput(canonical, input.secret);
  return {
    [LAN_AUTH_HEADER_NAMES.clientId]: input.clientId,
    [LAN_AUTH_HEADER_NAMES.timestamp]: String(timestamp),
    [LAN_AUTH_HEADER_NAMES.nonce]: nonce,
    [LAN_AUTH_HEADER_NAMES.contentSha256]: input.contentSha256,
    [LAN_AUTH_HEADER_NAMES.signature]: signature,
  };
};

export class NonceReplayGuard {
  readonly #nonces = new Map<string, Map<string, number>>();
  readonly #ttlMs: number;
  readonly #maximumPerClient: number;
  readonly #maximumClients: number;

  constructor(
    options: {
      ttlMs?: number;
      maximumPerClient?: number;
      maximumClients?: number;
    } = {}
  ) {
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maximumPerClient = options.maximumPerClient ?? 2_048;
    this.#maximumClients = options.maximumClients ?? 128;
  }

  consume(clientId: string, nonce: string, nowMs = Date.now()): boolean {
    for (const [knownClientId, nonces] of this.#nonces) {
      for (const [knownNonce, expiresAt] of nonces) {
        if (expiresAt <= nowMs) {
          nonces.delete(knownNonce);
        }
      }
      if (nonces.size === 0) {
        this.#nonces.delete(knownClientId);
      }
    }

    let clientNonces = this.#nonces.get(clientId);
    if (!clientNonces) {
      if (this.#nonces.size >= this.#maximumClients) {
        return false;
      }
      clientNonces = new Map();
      this.#nonces.set(clientId, clientNonces);
    }
    if (clientNonces.has(nonce)) {
      return false;
    }
    if (clientNonces.size >= this.#maximumPerClient) {
      return false;
    }
    clientNonces.set(nonce, nowMs + this.#ttlMs);
    return true;
  }

  revoke(clientId: string): void {
    this.#nonces.delete(clientId);
  }
}

export const verifyAuthHeaders = (input: {
  headers: LanAuthHeaderValues;
  secret: string;
  method: string;
  pathname: string;
  contentLength: number;
  now?: number;
  maximumClockSkewSeconds?: number;
  replayGuard?: NonceReplayGuard;
}): void => {
  const now = input.now ?? Date.now();
  const canonical = canonicalizeAuthInput({
    clientId: input.headers.clientId,
    method: input.method,
    pathname: input.pathname,
    timestamp: input.headers.timestamp,
    nonce: input.headers.nonce,
    contentLength: input.contentLength,
    contentSha256: input.headers.contentSha256,
  });
  const timestamp = Number(input.headers.timestamp);
  const maximumClockSkew = input.maximumClockSkewSeconds ?? 60;
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(now / 1_000) - timestamp) > maximumClockSkew ||
    !/^[a-f0-9]{64}$/.test(input.headers.signature)
  ) {
    throw new Error("Invalid LAN authentication");
  }

  const expected = Buffer.from(
    signCanonicalInput(canonical, input.secret),
    "hex"
  );
  const actual = Buffer.from(input.headers.signature, "hex");
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw new Error("Invalid LAN authentication");
  }
  if (
    input.replayGuard &&
    !input.replayGuard.consume(input.headers.clientId, input.headers.nonce, now)
  ) {
    throw new Error("Invalid LAN authentication");
  }
};

export const readAuthHeaderValues = (
  headers: Record<string, string | string[] | undefined>
): LanAuthHeaderValues => {
  const read = (name: string): string => {
    const value = headers[name];
    if (typeof value !== "string") {
      throw new Error("Invalid LAN authentication");
    }
    return value;
  };
  return {
    clientId: read(LAN_AUTH_HEADER_NAMES.clientId),
    timestamp: read(LAN_AUTH_HEADER_NAMES.timestamp),
    nonce: read(LAN_AUTH_HEADER_NAMES.nonce),
    contentSha256: read(LAN_AUTH_HEADER_NAMES.contentSha256),
    signature: read(LAN_AUTH_HEADER_NAMES.signature),
  };
};
