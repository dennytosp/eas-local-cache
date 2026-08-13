import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import {
  certificateMatchesPeerId,
  validateServerIdentity,
} from "./certificate";
import type {
  LanAuthorizedClient,
  LanCapabilities,
  LanEndpoint,
  LanOutboundPeer,
  LanServerIdentity,
  LanState,
} from "./types";

const STATE_FILE_NAME = "lan.json";
const STATE_LOCK_NAME = "lan.lock";
const MAX_STATE_BYTES = 256 * 1024;
const MAX_COLLECTION_ENTRIES = 128;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_STALE_MS = 2 * 60_000;

const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
const delay = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBase64UrlSecret = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, "base64url").toString("base64url") === value;

const isPeerId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const parseTimestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 40) {
    throw new Error("Invalid LAN state timestamp");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Invalid LAN state timestamp");
  }
  return value;
};

const parseCapabilities = (value: unknown): LanCapabilities => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["read", "write"]) ||
    typeof value.read !== "boolean" ||
    typeof value.write !== "boolean"
  ) {
    throw new Error("Invalid LAN capabilities");
  }
  return { read: value.read, write: value.write };
};

const parseEndpoint = (value: unknown): LanEndpoint => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["host", "port"]) ||
    typeof value.host !== "string" ||
    value.host.length === 0 ||
    value.host.length > 253 ||
    [...value.host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535
  ) {
    throw new Error("Invalid LAN peer endpoint");
  }
  return { host: value.host, port: value.port as number };
};

const parseCertificatePem = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 32 * 1024 ||
    !value.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !value.endsWith("-----END CERTIFICATE-----\n")
  ) {
    throw new Error("Invalid LAN certificate PEM");
  }
  try {
    if (new crypto.X509Certificate(value).toString() !== value) {
      throw new Error("non-canonical certificate");
    }
  } catch {
    throw new Error("Invalid LAN certificate PEM");
  }
  return value;
};

const parsePrivateKeyPem = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 32 * 1024 ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n/.test(value) ||
    !/-----END (?:RSA )?PRIVATE KEY-----\n$/.test(value)
  ) {
    throw new Error("Invalid LAN private key PEM");
  }
  try {
    const canonical = crypto
      .createPrivateKey(value)
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    if (canonical !== value) {
      throw new Error("non-canonical private key");
    }
  } catch {
    throw new Error("Invalid LAN private key PEM");
  }
  return value;
};

const parseServerIdentity = (value: unknown): LanServerIdentity | null => {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "peerId",
      "certificatePem",
      "privateKeyPem",
      "createdAt",
      "expiresAt",
    ]) ||
    !isPeerId(value.peerId)
  ) {
    throw new Error("Invalid LAN server identity");
  }
  const identity: LanServerIdentity = {
    peerId: value.peerId,
    certificatePem: parseCertificatePem(value.certificatePem),
    privateKeyPem: parsePrivateKeyPem(value.privateKeyPem),
    createdAt: parseTimestamp(value.createdAt),
    expiresAt: parseTimestamp(value.expiresAt),
  };
  validateServerIdentity(identity, { allowExpired: true });
  return identity;
};

const parseAlias = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("Invalid LAN peer alias");
  }
  return value;
};

const parseOutboundPeer = (value: unknown): LanOutboundPeer => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "peerId",
      "alias",
      "certificatePem",
      "endpoint",
      "secret",
      "capabilities",
      "enabled",
      "createdAt",
      "updatedAt",
      "lastSuccessAt",
    ]) ||
    !isPeerId(value.peerId) ||
    !isBase64UrlSecret(value.secret) ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Invalid outbound LAN peer");
  }
  const certificatePem = parseCertificatePem(value.certificatePem);
  if (!certificateMatchesPeerId(certificatePem, value.peerId)) {
    throw new Error("Outbound LAN peer certificate mismatch");
  }
  return {
    peerId: value.peerId,
    alias: parseAlias(value.alias),
    certificatePem,
    endpoint: parseEndpoint(value.endpoint),
    secret: value.secret,
    capabilities: parseCapabilities(value.capabilities),
    enabled: value.enabled,
    createdAt: parseTimestamp(value.createdAt),
    updatedAt: parseTimestamp(value.updatedAt),
    lastSuccessAt:
      value.lastSuccessAt === null ? null : parseTimestamp(value.lastSuccessAt),
  };
};

const parseAuthorizedClient = (value: unknown): LanAuthorizedClient => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "clientId",
      "secret",
      "capabilities",
      "status",
      "pairingId",
      "createdAt",
      "updatedAt",
    ]) ||
    !isBase64UrlSecret(value.clientId) ||
    !isBase64UrlSecret(value.secret) ||
    !["pending", "active", "revoked"].includes(value.status as string) ||
    !(
      value.pairingId === null ||
      (typeof value.pairingId === "string" &&
        /^[A-Za-z0-9_-]{22,43}$/.test(value.pairingId))
    )
  ) {
    throw new Error("Invalid authorized LAN client");
  }
  return {
    clientId: value.clientId,
    secret: value.secret,
    capabilities: parseCapabilities(value.capabilities),
    status: value.status as LanAuthorizedClient["status"],
    pairingId: value.pairingId,
    createdAt: parseTimestamp(value.createdAt),
    updatedAt: parseTimestamp(value.updatedAt),
  };
};

export const parseLanState = (value: unknown): LanState => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema",
      "clientId",
      "serverIdentity",
      "outboundPeers",
      "authorizedClients",
    ]) ||
    value.schema !== 1 ||
    !isBase64UrlSecret(value.clientId) ||
    !Array.isArray(value.outboundPeers) ||
    !Array.isArray(value.authorizedClients) ||
    value.outboundPeers.length > MAX_COLLECTION_ENTRIES ||
    value.authorizedClients.length > MAX_COLLECTION_ENTRIES
  ) {
    throw new Error("Invalid LAN state schema");
  }
  const outboundPeers = value.outboundPeers.map(parseOutboundPeer);
  const authorizedClients = value.authorizedClients.map(parseAuthorizedClient);
  if (
    new Set(outboundPeers.map((peer) => peer.peerId)).size !==
    outboundPeers.length
  ) {
    throw new Error("Duplicate outbound LAN peer");
  }
  if (
    new Set(authorizedClients.map((client) => client.clientId)).size !==
    authorizedClients.length
  ) {
    throw new Error("Duplicate authorized LAN client");
  }
  return {
    schema: 1,
    clientId: value.clientId,
    serverIdentity: parseServerIdentity(value.serverIdentity),
    outboundPeers,
    authorizedClients,
  };
};

const assertOwnedSecureDirectory = (candidate: string): void => {
  const stats = fs.lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("LAN state parent must be a real directory");
  }
  if (process.platform !== "win32") {
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("LAN state parent permissions are too broad");
    }
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error("LAN state parent has a different owner");
    }
  }
};

const assertProviderRoot = (providerRoot: string): void => {
  const stats = fs.lstatSync(providerRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("LAN provider root must be a real directory");
  }
};

const ensureStateDirectory = (providerRoot: string): string => {
  assertProviderRoot(providerRoot);
  const stateRoot = path.join(providerRoot, "state");
  try {
    fs.mkdirSync(stateRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const stats = fs.lstatSync(stateRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("LAN state parent must be a real directory");
  }
  if (process.platform !== "win32") {
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error("LAN state parent has a different owner");
    }
    fs.chmodSync(stateRoot, 0o700);
  }
  assertOwnedSecureDirectory(stateRoot);
  return stateRoot;
};

export const getLanStatePath = (providerRoot: string): string =>
  path.join(providerRoot, "state", STATE_FILE_NAME);

const openLanState = (statePath: string): number =>
  fs.openSync(statePath, fs.constants.O_RDONLY | noFollowFlag);

export const readLanState = (providerRoot: string): LanState | null => {
  const stateRoot = path.join(providerRoot, "state");
  try {
    assertProviderRoot(providerRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const statePath = getLanStatePath(providerRoot);
  let descriptor: number;
  try {
    descriptor = openLanState(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    assertOwnedSecureDirectory(stateRoot);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STATE_BYTES) {
      throw new Error("Invalid LAN state file");
    }
    if (stats.nlink !== 1) {
      throw new Error("LAN state file must not be hard-linked");
    }
    if (process.platform !== "win32") {
      if ((stats.mode & 0o077) !== 0) {
        throw new Error("LAN state file permissions are too broad");
      }
      if (
        typeof process.getuid === "function" &&
        stats.uid !== process.getuid()
      ) {
        throw new Error("LAN state file has a different owner");
      }
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid LAN state JSON");
    }
    const state = parseLanState(parsed);
    if (raw !== `${JSON.stringify(state)}\n`) {
      throw new Error("LAN state JSON is not canonical");
    }
    return state;
  } finally {
    fs.closeSync(descriptor);
  }
};

const createEmptyState = (): LanState => ({
  schema: 1,
  clientId: crypto.randomBytes(32).toString("base64url"),
  serverIdentity: null,
  outboundPeers: [],
  authorizedClients: [],
});

type StateLock = { directory: string; token: string };

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireStateLock = async (stateRoot: string): Promise<StateLock> => {
  const directory = path.join(stateRoot, STATE_LOCK_NAME);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (true) {
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      try {
        fs.writeFileSync(
          path.join(directory, "owner.json"),
          `${JSON.stringify({ token, pid: process.pid })}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" }
        );
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return { directory, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    try {
      const stats = fs.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Unsafe LAN state lock");
      }
      let ownerPid: number | null = null;
      try {
        const owner: unknown = JSON.parse(
          fs.readFileSync(path.join(directory, "owner.json"), "utf8")
        );
        if (
          isRecord(owner) &&
          exactKeys(owner, ["token", "pid"]) &&
          typeof owner.token === "string" &&
          Number.isSafeInteger(owner.pid) &&
          (owner.pid as number) > 0
        ) {
          ownerPid = owner.pid as number;
        }
      } catch {
        // A partial owner is stale only after the conservative age limit.
      }
      const stale =
        ownerPid === null
          ? Date.now() - stats.mtimeMs > STATE_LOCK_STALE_MS
          : !isProcessAlive(ownerPid);
      if (stale) {
        const tombstone = `${directory}.stale-${
          process.pid
        }-${crypto.randomUUID()}`;
        try {
          fs.renameSync(directory, tombstone);
          fs.rmSync(tombstone, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (
            !["ENOENT", "EEXIST"].includes(
              (error as NodeJS.ErrnoException).code ?? ""
            )
          ) {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for LAN state lock");
    }
    await delay(25 + Math.floor(Math.random() * 20));
  }
};

const releaseStateLock = (lock: StateLock): void => {
  try {
    const owner: unknown = JSON.parse(
      fs.readFileSync(path.join(lock.directory, "owner.json"), "utf8")
    );
    if (isRecord(owner) && owner.token === lock.token) {
      fs.rmSync(lock.directory, { recursive: true, force: true });
    }
  } catch {
    // A replaced or removed lock is no longer ours to release.
  }
};

const atomicWriteState = (stateRoot: string, state: LanState): void => {
  const validated = parseLanState(state);
  const contents = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(contents) > MAX_STATE_BYTES) {
    throw new Error("LAN state is too large");
  }
  const statePath = path.join(stateRoot, STATE_FILE_NAME);
  const temporaryPath = path.join(
    stateRoot,
    `.lan-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollowFlag,
      0o600
    );
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, statePath);
    if (process.platform !== "win32") {
      const directoryDescriptor = fs.openSync(stateRoot, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup; the private sibling cannot become committed state.
    }
  }
};

export const updateLanState = async (
  providerRoot: string,
  updater: (state: LanState) => LanState | void
): Promise<LanState> => {
  const stateRoot = ensureStateDirectory(providerRoot);
  const lock = await acquireStateLock(stateRoot);
  try {
    const current = readLanState(providerRoot) ?? createEmptyState();
    const working = structuredClone(current);
    const updated = updater(working) ?? working;
    const validated = parseLanState(updated);
    atomicWriteState(stateRoot, validated);
    return validated;
  } finally {
    releaseStateLock(lock);
  }
};

export const writeLanState = async (
  providerRoot: string,
  state: LanState
): Promise<void> => {
  await updateLanState(providerRoot, () => state);
};

export const ensureLanState = async (providerRoot: string): Promise<LanState> =>
  updateLanState(providerRoot, (state) => state);
