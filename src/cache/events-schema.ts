import type { CachePlatform } from "./paths";

export const RESOLVE_EVENT_SCHEMA_VERSION = 1;
export const RESOLVE_EVENT_RETENTION_DAYS = 90;
export const RESOLVE_EVENT_MAX_COUNT = 10_000;
export const RESOLVE_EVENT_MAX_BYTES = 16 * 1024;
export const RESOLVE_EVENT_MAX_LOOKUP_DURATION_MS = 24 * 60 * 60 * 1000;
export const RESOLVE_EVENT_MAX_TIME_SAVED_MS = 6 * 60 * 60 * 1000;

export const RETENTION_MS = RESOLVE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const EVENT_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const EVENT_FILE_PATTERN =
  /^(\d{8}T\d{9}Z)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/;
export const EVENT_TEMP_FILE_PATTERN =
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
  "build-profile-changed",
  "xcode-changed",
  "platform-sdk-changed",
  "jdk-changed",
  "gradle-changed",
  "architecture-changed",
  "manual-environment-changed",
  "environment-key-upgraded",
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

export type EventLock = {
  directory: string;
  token: string;
};

export type EventLockOwner = {
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedNonNegative = (
  value: unknown,
  maximum: number
): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= maximum;

export const isCanonicalTimestamp = (value: unknown): value is string => {
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

export const parseResolveEvent = (value: unknown): ResolveEvent => {
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
