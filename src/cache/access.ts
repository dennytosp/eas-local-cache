import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { assertManagedDirectory, ensureManagedDirectory } from "./filesystem";
import type { CachePlatform } from "./paths";

export const ACCESS_SCHEMA_VERSION = 1;
export const DEFAULT_ACCESS_LEASE_MS = 15 * 60 * 1000;

export type AccessRecord = {
  schemaVersion: 1;
  entryId: string;
  platform: CachePlatform;
  lastAccessedAt: string;
  protectedUntil: string;
};

export type TouchAccessRecordOptions = {
  now?: Date;
  leaseMs?: number;
};

const ENTRY_ID_PATTERN = /^[a-f0-9]{64}$/;

const assertSafeEntryId = (entryId: string): void => {
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error("Access metadata requires a 64-character cache entry id");
  }
};

const getAccessPath = (accessRoot: string, entryId: string): string => {
  assertSafeEntryId(entryId);
  return path.join(accessRoot, `${entryId}.json`);
};

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

const assertRegularFile = (candidate: string): void => {
  const stats = fs.lstatSync(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Access metadata must be a regular file");
  }
};

const readRegularFile = (candidate: string): string => {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Access metadata must be a regular file");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
};

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const parseAccessRecord = (
  value: unknown,
  expectedEntryId: string
): AccessRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed cache access metadata");
  }

  const record = value as Record<string, unknown>;
  const valid =
    record.schemaVersion === ACCESS_SCHEMA_VERSION &&
    record.entryId === expectedEntryId &&
    (record.platform === "android" || record.platform === "ios") &&
    isValidTimestamp(record.lastAccessedAt) &&
    isValidTimestamp(record.protectedUntil) &&
    Date.parse(record.protectedUntil) >= Date.parse(record.lastAccessedAt);

  if (!valid) {
    throw new Error("Malformed cache access metadata fields");
  }

  return record as AccessRecord;
};

export const readAccessRecord = (
  accessRoot: string,
  entryId: string,
  providerRoot: string
): AccessRecord | null => {
  const accessPath = getAccessPath(accessRoot, entryId);
  try {
    assertManagedDirectory(providerRoot, accessRoot);
    const value: unknown = JSON.parse(readRegularFile(accessPath));
    return parseAccessRecord(value, entryId);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
};

const assertTouchOptions = (
  now: Date,
  leaseMs: number
): { nowMs: number; leaseMs: number } => {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Access metadata requires a valid current date");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) {
    throw new Error("Access lease must be a non-negative safe integer");
  }

  return { nowMs, leaseMs };
};

export const touchAccessRecord = (
  accessRoot: string,
  entryId: string,
  platform: CachePlatform,
  options: TouchAccessRecordOptions & { providerRoot?: string } = {}
): AccessRecord => {
  const accessPath = getAccessPath(accessRoot, entryId);
  const { nowMs, leaseMs } = assertTouchOptions(
    options.now ?? new Date(),
    options.leaseMs ?? DEFAULT_ACCESS_LEASE_MS
  );
  if (!options.providerRoot) {
    throw new Error("Access metadata requires a trusted provider root");
  }
  ensureManagedDirectory(options.providerRoot, accessRoot);

  let existing: AccessRecord | null = null;
  try {
    assertRegularFile(accessPath);
    try {
      existing = readAccessRecord(accessRoot, entryId, options.providerRoot);
    } catch {
      // Invalid mutable metadata is safely replaced instead of blocking a hit.
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  const lastAccessedAtMs = Math.max(
    nowMs,
    existing ? Date.parse(existing.lastAccessedAt) : Number.NEGATIVE_INFINITY
  );
  const protectedUntilMs = Math.max(
    lastAccessedAtMs + leaseMs,
    existing ? Date.parse(existing.protectedUntil) : Number.NEGATIVE_INFINITY
  );
  if (!Number.isFinite(new Date(protectedUntilMs).getTime())) {
    throw new Error("Access lease exceeds the supported date range");
  }
  const record: AccessRecord = {
    schemaVersion: ACCESS_SCHEMA_VERSION,
    entryId,
    platform,
    lastAccessedAt: new Date(lastAccessedAtMs).toISOString(),
    protectedUntil: new Date(protectedUntilMs).toISOString(),
  };
  const temporaryPath = path.join(
    accessRoot,
    `.${entryId}.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, accessPath);
    return record;
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // The final record was already published; temp cleanup is best effort.
    }
  }
};

export const removeAccessRecord = (
  accessRoot: string,
  entryId: string,
  providerRoot: string
): boolean => {
  const accessPath = getAccessPath(accessRoot, entryId);
  try {
    assertManagedDirectory(providerRoot, accessRoot);
    assertRegularFile(accessPath);
    fs.unlinkSync(accessPath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
};
