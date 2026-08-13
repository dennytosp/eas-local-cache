import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ensureRealDirectoryTree, isPathInside } from "./filesystem";
import type { CachePlatform } from "./paths";

export const RESOLVE_EVENT_SCHEMA_VERSION = 1;
export const RESOLVE_EVENT_RETENTION_DAYS = 90;
export const RESOLVE_EVENT_MAX_COUNT = 10_000;
export const RESOLVE_EVENT_MAX_BYTES = 16 * 1024;
export const RESOLVE_EVENT_MAX_LOOKUP_DURATION_MS = 24 * 60 * 60 * 1000;
export const RESOLVE_EVENT_MAX_TIME_SAVED_MS = 6 * 60 * 60 * 1000;

const RETENTION_MS = RESOLVE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const EVENT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_FILE_PATTERN =
  /^(\d{8}T\d{9}Z)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/;
const EVENT_TEMP_FILE_PATTERN =
  /^\.tmp-\d+-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ENTRY_ID_PATTERN = /^[a-f0-9]{64}$/;

export const RESOLVE_EXPLANATION_CODES = [
  "hit",
  "no-entry",
  "corrupt-entry",
  "writer-lock-busy",
  "unsafe-legacy-path",
  "legacy-invalid",
  "provider-error",
  "fingerprint-unavailable",
  "expo-config-changed",
  "native-dependencies-changed",
  "native-project-changed",
  "project-metadata-changed",
  "other-inputs-changed",
  "no-compatible-insight",
  "fingerprint-engine-mismatch",
] as const;

export type ResolveExplanationCode = (typeof RESOLVE_EXPLANATION_CODES)[number];
export type ResolveEventOutcome = "hit" | "miss" | "error";

export type ResolveEvent = {
  schemaVersion: 1;
  timestamp: string;
  platform: CachePlatform;
  entryId: string;
  outcome: ResolveEventOutcome;
  lookupDurationMs: number;
  explanationCode: ResolveExplanationCode;
  estimatedTimeSavedMs?: number;
};

export type ResolveEventInput = Omit<
  ResolveEvent,
  "schemaVersion" | "timestamp"
>;

export type StoredResolveEvent = {
  event: ResolveEvent;
  filePath: string;
  sizeBytes: number;
};

export type InvalidResolveEvent = {
  filePath: string;
  sizeBytes: number;
  reason: string;
};

export type ResolveEventScan = {
  events: StoredResolveEvent[];
  invalid: InvalidResolveEvent[];
  validBytes: number;
  invalidBytes: number;
  totalBytes: number;
};

export type ResolveEventSummary = {
  eventCount: number;
  hits: number;
  misses: number;
  errors: number;
  hitRate: number | null;
  lookupDurationMs: number;
  estimatedTimeSavedMs: number;
  hitsWithoutEstimate: number;
  windowStart: string | null;
  windowEnd: string | null;
};

export type RecordResolveEventResult =
  | { status: "recorded"; event: ResolveEvent; filePath: string }
  | { status: "lock-busy" }
  | { status: "failed"; error: Error };

export type ResolveEventPruneCandidate = {
  filePath: string;
  timestamp: string | null;
  sizeBytes: number;
  reason: "invalid" | "expired" | "event-count";
};

export type PruneResolveEventsResult =
  | {
      status: "pruned";
      candidates: ResolveEventPruneCandidate[];
      removed: ResolveEventPruneCandidate[];
      removedCount: number;
      removedBytes: number;
    }
  | { status: "lock-busy" }
  | { status: "failed"; error: Error };

type EventLock = {
  directory: string;
  token: string;
};

type EventLockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

export type RecordResolveEventOptions = {
  nowMs?: number;
  maxLockWaitMs?: number;
  lockRetryIntervalMs?: number;
  staleLockMs?: number;
  randomUUID?: () => string;
};

export type PruneResolveEventsOptions = Pick<
  RecordResolveEventOptions,
  "nowMs" | "maxLockWaitMs" | "lockRetryIntervalMs" | "staleLockMs"
> & {
  dryRun?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedNonNegative = (
  value: unknown,
  maximum: number
): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= maximum;

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
};

const isExplanationCode = (value: unknown): value is ResolveExplanationCode =>
  typeof value === "string" &&
  (RESOLVE_EXPLANATION_CODES as readonly string[]).includes(value);

const parseResolveEvent = (value: unknown): ResolveEvent => {
  if (!isRecord(value)) {
    throw new Error("Resolve event must be an object");
  }

  const allowedKeys = new Set([
    "schemaVersion",
    "timestamp",
    "platform",
    "entryId",
    "outcome",
    "lookupDurationMs",
    "explanationCode",
    "estimatedTimeSavedMs",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Resolve event contains unsupported fields");
  }

  const valid =
    value.schemaVersion === RESOLVE_EVENT_SCHEMA_VERSION &&
    isCanonicalTimestamp(value.timestamp) &&
    (value.platform === "android" || value.platform === "ios") &&
    typeof value.entryId === "string" &&
    ENTRY_ID_PATTERN.test(value.entryId) &&
    (value.outcome === "hit" ||
      value.outcome === "miss" ||
      value.outcome === "error") &&
    isBoundedNonNegative(
      value.lookupDurationMs,
      RESOLVE_EVENT_MAX_LOOKUP_DURATION_MS
    ) &&
    isExplanationCode(value.explanationCode) &&
    (value.estimatedTimeSavedMs === undefined ||
      (value.outcome === "hit" &&
        isBoundedNonNegative(
          value.estimatedTimeSavedMs,
          RESOLVE_EVENT_MAX_TIME_SAVED_MS
        )));

  if (!valid) {
    throw new Error("Resolve event contains malformed fields");
  }

  return value as ResolveEvent;
};

const getUtcDay = (timestamp: string): string => timestamp.slice(0, 10);

const getTimestampToken = (timestamp: string): string =>
  timestamp.replaceAll("-", "").replaceAll(":", "").replace(".", "");

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const safeReadJsonFile = (filePath: string, maxBytes: number): unknown => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("Telemetry record must be a regular file");
    }
    if (stats.size > maxBytes) {
      throw new Error("Telemetry record exceeds its size limit");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
  } finally {
    fs.closeSync(descriptor);
  }
};

const readLockOwner = (lockDirectory: string): EventLockOwner | null => {
  try {
    const value = safeReadJsonFile(
      path.join(lockDirectory, "owner.json"),
      4096
    );
    if (
      isRecord(value) &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      typeof value.hostname === "string" &&
      isCanonicalTimestamp(value.createdAt)
    ) {
      return value as EventLockOwner;
    }
  } catch {
    // A malformed young lock is retained until the conservative stale timeout.
  }
  return null;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isEventLockStale = (
  lockDirectory: string,
  staleLockMs: number,
  nowMs: number
): boolean => {
  const stats = fs.lstatSync(lockDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return false;
  }
  const owner = readLockOwner(lockDirectory);
  if (!owner) {
    return nowMs - stats.mtimeMs > staleLockMs;
  }
  if (owner.hostname === os.hostname()) {
    return !isProcessAlive(owner.pid);
  }
  return nowMs - stats.mtimeMs > staleLockMs;
};

const breakStaleEventLock = (lockDirectory: string): boolean => {
  const tombstone = `${lockDirectory}.stale-${
    process.pid
  }-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDirectory, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") {
      return false;
    }
    throw error;
  }
};

const acquireEventLock = async (
  eventsRoot: string,
  options: Required<
    Pick<
      RecordResolveEventOptions,
      "maxLockWaitMs" | "lockRetryIntervalMs" | "staleLockMs"
    >
  >,
  now: () => number
): Promise<EventLock | null> => {
  const lockDirectory = path.join(eventsRoot, ".telemetry.lock");
  const deadline = now() + options.maxLockWaitMs;

  while (true) {
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(lockDirectory);
      const owner: EventLockOwner = {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date(now()).toISOString(),
      };
      try {
        fs.writeFileSync(
          path.join(lockDirectory, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      } catch (error) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return { directory: lockDirectory, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    try {
      if (isEventLockStale(lockDirectory, options.staleLockMs, now())) {
        breakStaleEventLock(lockDirectory);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (now() >= deadline) {
      return null;
    }
    await delay(options.lockRetryIntervalMs);
  }
};

const releaseEventLock = (lock: EventLock): void => {
  const owner = readLockOwner(lock.directory);
  if (owner?.token === lock.token) {
    fs.rmSync(lock.directory, { recursive: true, force: true });
  }
};

const assertEventsRoot = (eventsRoot: string): void => {
  const stats = fs.lstatSync(eventsRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Telemetry root must be a real directory");
  }
};

const eventFileNames = (eventsRoot: string): Array<[string, string]> => {
  try {
    assertEventsRoot(eventsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: Array<[string, string]> = [];
  for (const dayName of fs.readdirSync(eventsRoot)) {
    if (!EVENT_DAY_PATTERN.test(dayName)) {
      continue;
    }
    const dayDirectory = path.join(eventsRoot, dayName);
    try {
      const dayStats = fs.lstatSync(dayDirectory);
      if (dayStats.isSymbolicLink() || !dayStats.isDirectory()) {
        continue;
      }
      for (const fileName of fs.readdirSync(dayDirectory)) {
        if (
          EVENT_FILE_PATTERN.test(fileName) ||
          EVENT_TEMP_FILE_PATTERN.test(fileName)
        ) {
          files.push([dayName, fileName]);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return files;
};

export const scanResolveEvents = (eventsRoot: string): ResolveEventScan => {
  const events: StoredResolveEvent[] = [];
  const invalid: InvalidResolveEvent[] = [];

  for (const [dayName, fileName] of eventFileNames(eventsRoot)) {
    const filePath = path.join(eventsRoot, dayName, fileName);
    let sizeBytes = 0;
    try {
      const stats = fs.lstatSync(filePath);
      sizeBytes = stats.size;
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error("Telemetry record must be a regular file");
      }
      if (stats.size > RESOLVE_EVENT_MAX_BYTES) {
        throw new Error("Telemetry record exceeds its size limit");
      }
      const event = parseResolveEvent(
        safeReadJsonFile(filePath, RESOLVE_EVENT_MAX_BYTES)
      );
      const fileMatch = EVENT_FILE_PATTERN.exec(fileName);
      if (
        !fileMatch ||
        getUtcDay(event.timestamp) !== dayName ||
        getTimestampToken(event.timestamp) !== fileMatch[1]
      ) {
        throw new Error("Telemetry timestamp does not match its UTC path");
      }
      events.push({ event, filePath, sizeBytes: stats.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      invalid.push({
        filePath,
        sizeBytes,
        reason:
          error instanceof Error ? error.message : "Invalid telemetry record",
      });
    }
  }

  events.sort(
    (left, right) =>
      left.event.timestamp.localeCompare(right.event.timestamp) ||
      left.filePath.localeCompare(right.filePath)
  );
  const validBytes = events.reduce((total, item) => total + item.sizeBytes, 0);
  const invalidBytes = invalid.reduce(
    (total, item) => total + item.sizeBytes,
    0
  );
  return {
    events,
    invalid,
    validBytes,
    invalidBytes,
    totalBytes: validBytes + invalidBytes,
  };
};

const removeEvent = (eventsRoot: string, eventPath: string): void => {
  if (!isPathInside(eventsRoot, eventPath)) {
    throw new Error("Telemetry event escapes its managed root");
  }
  fs.unlinkSync(eventPath);
};

const removeEmptyDayDirectories = (eventsRoot: string): void => {
  for (const dayName of fs.readdirSync(eventsRoot)) {
    if (!EVENT_DAY_PATTERN.test(dayName)) {
      continue;
    }
    const dayDirectory = path.join(eventsRoot, dayName);
    try {
      const stats = fs.lstatSync(dayDirectory);
      if (
        !stats.isSymbolicLink() &&
        stats.isDirectory() &&
        fs.readdirSync(dayDirectory).length === 0
      ) {
        fs.rmdirSync(dayDirectory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
};

const selectRetentionCandidates = (
  scan: ResolveEventScan,
  nowMs: number,
  maximumSurvivors: number
): ResolveEventPruneCandidate[] => {
  const cutoffMs = nowMs - RETENTION_MS;
  const expired = scan.events.filter(
    ({ event }) => Date.parse(event.timestamp) < cutoffMs
  );
  const expiredPaths = new Set(expired.map(({ filePath }) => filePath));
  const retained = scan.events.filter(
    ({ filePath }) => !expiredPaths.has(filePath)
  );
  const excessCount = Math.max(0, retained.length - maximumSurvivors);
  return [
    ...scan.invalid.map(({ filePath, sizeBytes }) => ({
      filePath,
      timestamp: null,
      sizeBytes,
      reason: "invalid" as const,
    })),
    ...expired.map(({ event, filePath, sizeBytes }) => ({
      filePath,
      timestamp: event.timestamp,
      sizeBytes,
      reason: "expired" as const,
    })),
    ...retained.slice(0, excessCount).map(({ event, filePath, sizeBytes }) => ({
      filePath,
      timestamp: event.timestamp,
      sizeBytes,
      reason: "event-count" as const,
    })),
  ];
};

const applyRetention = (
  eventsRoot: string,
  candidates: readonly ResolveEventPruneCandidate[]
): {
  removed: ResolveEventPruneCandidate[];
  removedCount: number;
  removedBytes: number;
} => {
  const removed: ResolveEventPruneCandidate[] = [];
  let removedCount = 0;
  let removedBytes = 0;
  for (const candidate of candidates) {
    try {
      removeEvent(eventsRoot, candidate.filePath);
      removed.push(candidate);
      removedCount += 1;
      removedBytes += candidate.sizeBytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  removeEmptyDayDirectories(eventsRoot);
  return { removed, removedCount, removedBytes };
};

const validateEventInput = (
  input: ResolveEventInput,
  timestamp: string
): ResolveEvent =>
  parseResolveEvent({
    schemaVersion: RESOLVE_EVENT_SCHEMA_VERSION,
    timestamp,
    ...input,
  });

const publishEvent = (
  eventsRoot: string,
  event: ResolveEvent,
  randomUUID: () => string
): string => {
  const dayDirectory = path.join(eventsRoot, getUtcDay(event.timestamp));
  ensureRealDirectoryTree(eventsRoot, dayDirectory);

  const identifier = randomUUID().toLowerCase();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      identifier
    )
  ) {
    throw new Error("Telemetry event identifier must be a UUID v4");
  }
  const fileName = `${getTimestampToken(event.timestamp)}-${identifier}.json`;
  const finalPath = path.join(dayDirectory, fileName);
  const temporaryPath = path.join(
    dayDirectory,
    `.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  const contents = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(contents) > RESOLVE_EVENT_MAX_BYTES) {
    throw new Error("Telemetry record exceeds its size limit");
  }
  try {
    fs.lstatSync(finalPath);
    throw new Error("Telemetry event already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, finalPath);
    return finalPath;
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
};

export const recordResolveEvent = async (
  providerRoot: string,
  eventsRoot: string,
  input: ResolveEventInput,
  options: RecordResolveEventOptions = {}
): Promise<RecordResolveEventResult> => {
  try {
    ensureRealDirectoryTree(providerRoot, eventsRoot);
    const eventNowMs = options.nowMs ?? Date.now();
    const timestamp = new Date(eventNowMs).toISOString();
    const event = validateEventInput(input, timestamp);
    const lock = await acquireEventLock(
      eventsRoot,
      {
        maxLockWaitMs: options.maxLockWaitMs ?? 50,
        lockRetryIntervalMs: options.lockRetryIntervalMs ?? 10,
        staleLockMs: options.staleLockMs ?? 60_000,
      },
      Date.now
    );
    if (!lock) {
      return { status: "lock-busy" };
    }

    try {
      const candidates = selectRetentionCandidates(
        scanResolveEvents(eventsRoot),
        eventNowMs,
        RESOLVE_EVENT_MAX_COUNT - 1
      );
      applyRetention(eventsRoot, candidates);
      const filePath = publishEvent(
        eventsRoot,
        event,
        options.randomUUID ?? crypto.randomUUID
      );
      return { status: "recorded", event, filePath };
    } finally {
      releaseEventLock(lock);
    }
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error ? error : new Error("Telemetry write failed"),
    };
  }
};

export const pruneResolveEvents = async (
  providerRoot: string,
  eventsRoot: string,
  options: PruneResolveEventsOptions = {}
): Promise<PruneResolveEventsResult> => {
  try {
    if (!fs.existsSync(eventsRoot)) {
      return {
        status: "pruned",
        candidates: [],
        removed: [],
        removedCount: 0,
        removedBytes: 0,
      };
    }
    ensureRealDirectoryTree(providerRoot, eventsRoot);
    const nowMs = options.nowMs ?? Date.now();
    const lock = await acquireEventLock(
      eventsRoot,
      {
        maxLockWaitMs: options.maxLockWaitMs ?? 50,
        lockRetryIntervalMs: options.lockRetryIntervalMs ?? 10,
        staleLockMs: options.staleLockMs ?? 60_000,
      },
      Date.now
    );
    if (!lock) {
      return { status: "lock-busy" };
    }

    try {
      const candidates = selectRetentionCandidates(
        scanResolveEvents(eventsRoot),
        nowMs,
        RESOLVE_EVENT_MAX_COUNT
      );
      const removed = options.dryRun
        ? { removed: [], removedCount: 0, removedBytes: 0 }
        : applyRetention(eventsRoot, candidates);
      return { status: "pruned", candidates, ...removed };
    } finally {
      releaseEventLock(lock);
    }
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error ? error : new Error("Telemetry prune failed"),
    };
  }
};

export const summarizeResolveEvents = (
  events: readonly ResolveEvent[]
): ResolveEventSummary => {
  if (events.length > RESOLVE_EVENT_MAX_COUNT) {
    throw new Error("Resolve event aggregate exceeds the retained event limit");
  }
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let lookupDurationMs = 0;
  let estimatedTimeSavedMs = 0;
  let hitsWithoutEstimate = 0;
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  const addMetric = (total: number, value: number): number => {
    const next = total + value;
    if (!Number.isFinite(next) || !Number.isSafeInteger(Math.ceil(next))) {
      throw new Error("Resolve event aggregate exceeds the safe numeric range");
    }
    return next;
  };

  for (const event of events) {
    const validated = parseResolveEvent(event);
    lookupDurationMs = addMetric(lookupDurationMs, validated.lookupDurationMs);
    if (validated.outcome === "hit") {
      hits += 1;
      if (validated.estimatedTimeSavedMs === undefined) {
        hitsWithoutEstimate += 1;
      } else {
        estimatedTimeSavedMs = addMetric(
          estimatedTimeSavedMs,
          validated.estimatedTimeSavedMs
        );
      }
    } else if (validated.outcome === "miss") {
      misses += 1;
    } else {
      errors += 1;
    }
    if (windowStart === null || validated.timestamp < windowStart) {
      windowStart = validated.timestamp;
    }
    if (windowEnd === null || validated.timestamp > windowEnd) {
      windowEnd = validated.timestamp;
    }
  }

  const decisions = hits + misses;
  return {
    eventCount: events.length,
    hits,
    misses,
    errors,
    hitRate: decisions === 0 ? null : hits / decisions,
    lookupDurationMs,
    estimatedTimeSavedMs,
    hitsWithoutEstimate,
    windowStart,
    windowEnd,
  };
};
