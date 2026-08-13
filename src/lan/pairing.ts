import * as crypto from "crypto";

import { certificateMatchesPeerId } from "./certificate";
import type { LanServerIdentity } from "./types";

const PAIRING_PREFIX = "easlc://pair/v1/";
const MAX_PAIRING_URI_BYTES = 48 * 1024;
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;

export type PairingPayload = {
  version: 1;
  host: string;
  port: number;
  serverId: string;
  certificatePem: string;
  expiresAt: string;
  capability: string;
};

export type PairingOffer = {
  uri: string;
  payload: PairingPayload;
  capability: string;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

const validatePayload = (value: unknown): PairingPayload => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "version",
      "host",
      "port",
      "serverId",
      "certificatePem",
      "expiresAt",
      "capability",
    ])
  ) {
    throw new Error("Invalid LAN pairing code");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.host !== "string" ||
    payload.host.length === 0 ||
    payload.host.length > 253 ||
    [...payload.host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    !Number.isSafeInteger(payload.port) ||
    (payload.port as number) < 1 ||
    (payload.port as number) > 65_535 ||
    typeof payload.serverId !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.serverId) ||
    typeof payload.certificatePem !== "string" ||
    payload.certificatePem.length > 32 * 1024 ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.capability !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.capability)
  ) {
    throw new Error("Invalid LAN pairing code");
  }
  try {
    if (
      new crypto.X509Certificate(payload.certificatePem).toString() !==
      payload.certificatePem
    ) {
      throw new Error("non-canonical certificate");
    }
  } catch {
    throw new Error("Invalid LAN pairing code");
  }
  const expiresAt = new Date(payload.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== payload.expiresAt ||
    !certificateMatchesPeerId(payload.certificatePem, payload.serverId)
  ) {
    throw new Error("Invalid LAN pairing code");
  }
  return {
    version: 1,
    host: payload.host,
    port: payload.port as number,
    serverId: payload.serverId,
    certificatePem: payload.certificatePem,
    expiresAt: payload.expiresAt,
    capability: payload.capability,
  };
};

export const encodePairingUri = (payload: PairingPayload): string => {
  const validated = validatePayload(payload);
  const encoded = Buffer.from(JSON.stringify(validated), "utf8").toString(
    "base64url"
  );
  const uri = `${PAIRING_PREFIX}${encoded}`;
  if (Buffer.byteLength(uri) > MAX_PAIRING_URI_BYTES) {
    throw new Error("Invalid LAN pairing code");
  }
  return uri;
};

export const decodePairingUri = (
  uri: string,
  options: { now?: Date; allowExpired?: boolean } = {}
): PairingPayload => {
  if (
    Buffer.byteLength(uri) > MAX_PAIRING_URI_BYTES ||
    !uri.startsWith(PAIRING_PREFIX)
  ) {
    throw new Error("Invalid LAN pairing code");
  }
  const encoded = uri.slice(PAIRING_PREFIX.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid LAN pairing code");
  }
  let raw: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url");
    }
    raw = bytes.toString("utf8");
  } catch {
    throw new Error("Invalid LAN pairing code");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid LAN pairing code");
  }
  const payload = validatePayload(value);
  if (raw !== JSON.stringify(payload)) {
    throw new Error("Invalid LAN pairing code");
  }
  if (
    !options.allowExpired &&
    new Date(payload.expiresAt).getTime() <=
      (options.now ?? new Date()).getTime()
  ) {
    throw new Error("LAN pairing code has expired");
  }
  return payload;
};

export const createPairingOffer = (
  identity: LanServerIdentity,
  host: string,
  port: number,
  options: {
    now?: Date;
    ttlMs?: number;
    capability?: string;
  } = {}
): PairingOffer => {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) {
    throw new Error("Invalid LAN pairing lifetime");
  }
  const capability =
    options.capability ?? crypto.randomBytes(32).toString("base64url");
  const payload: PairingPayload = {
    version: 1,
    host,
    port,
    serverId: identity.peerId,
    certificatePem: identity.certificatePem,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    capability,
  };
  return { uri: encodePairingUri(payload), payload, capability };
};
