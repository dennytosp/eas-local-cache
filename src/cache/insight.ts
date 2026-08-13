import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { isPathInside } from "./filesystem";
import type { CachePlatform } from "./paths";

export const INSIGHT_SCHEMA_VERSION = 1;
export const INSIGHT_FILENAME = "insight.json";
export const MAX_INSIGHT_BYTES = 1024 * 1024;
export const MAX_INSIGHT_SOURCES = 10_000;
export const MAX_INSIGHT_DISPLAY_PATH_LENGTH = 256;

const MAX_IDENTITY_LENGTH = 16_384;
const MAX_HASH_LENGTH = 256;
const MAX_ENGINE_VERSION_LENGTH = 128;
const MAX_PROFILE_VALUE_LENGTH = 256;

export const EVIDENCE_CATEGORIES = [
  "expo-config",
  "native-dependencies",
  "native-project",
  "project-metadata",
  "other",
] as const;

export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export type IosRunProfile = {
  configuration: "Debug" | "Release";
  scheme: string;
};

export type AndroidRunProfile = {
  variant: string;
  allArch: boolean;
};

export type RunProfile = IosRunProfile | AndroidRunProfile;

export type RawFingerprintSource = {
  type: "file" | "dir" | "contents";
  hash: string | null;
  reasons?: unknown;
  filePath?: unknown;
  overrideHashKey?: unknown;
  id?: unknown;
  contents?: unknown;
  debugInfo?: unknown;
};

export type InsightSource = {
  type: RawFingerprintSource["type"];
  comparatorHash: string;
  occurrence: number;
  displayPath?: string;
  digest: string | null;
  categories: EvidenceCategory[];
};

export type FingerprintSnapshot = {
  platform: CachePlatform;
  fingerprintHash: string;
  capturedAt: string;
  fingerprintEngineVersion: string;
  runProfile: RunProfile;
  sources: InsightSource[];
};

export type ArtifactReadyEstimate = {
  durationMs: number;
  method: "artifact-mtime-v1";
};

export type CacheInsight = FingerprintSnapshot & {
  schemaVersion: 1;
  entryId: string;
  artifactReadyEstimate?: ArtifactReadyEstimate;
};

export type InsightDiffOperation = "added" | "removed" | "changed";

export type InsightDiffItem = {
  operation: InsightDiffOperation;
  category: EvidenceCategory;
  before?: InsightSource;
  after?: InsightSource;
};

export type InsightDiff = {
  items: InsightDiffItem[];
  added: number;
  removed: number;
  changed: number;
  total: number;
  groups: Array<{ category: EvidenceCategory; count: number }>;
};

export type InsightCandidate = {
  insight: CacheInsight;
  lastAccessAt?: string | null;
  createdAt: string;
  entryId: string;
};

export type ClosestInsightResult =
  | {
      status: "match";
      candidate: InsightCandidate;
      diff: InsightDiff;
    }
  | {
      status:
        | "no-compatible-profile"
        | "fingerprint-engine-mismatch"
        | "no-candidate";
      candidate: null;
      diff: null;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean => Object.keys(value).every((key) => allowedKeys.includes(key));

const isBoundedString = (
  value: unknown,
  maximumLength: number,
  allowEmpty = false
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  value.length <= maximumLength &&
  !hasControlCharacters(value);

const isIsoTimestamp = (value: unknown): value is string =>
  isBoundedString(value, 64) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isCachePlatform = (value: unknown): value is CachePlatform =>
  value === "android" || value === "ios";

const isEvidenceCategory = (value: unknown): value is EvidenceCategory =>
  EVIDENCE_CATEGORIES.includes(value as EvidenceCategory);

const normalizeProfileValue = (value: unknown, fallback: string): string =>
  isBoundedString(value, MAX_PROFILE_VALUE_LENGTH) ? value : fallback;

export const normalizeRunProfile = (
  platform: CachePlatform,
  runOptions: unknown
): RunProfile => {
  const options = isRecord(runOptions) ? runOptions : {};

  if (platform === "ios") {
    return {
      configuration: options.configuration === "Release" ? "Release" : "Debug",
      scheme: normalizeProfileValue(options.scheme, "default"),
    };
  }

  return {
    variant: normalizeProfileValue(options.variant, "debug"),
    allArch: options.allArch === true,
  };
};

export const runProfilesEqual = (
  platform: CachePlatform,
  left: RunProfile,
  right: RunProfile
): boolean => {
  if (platform === "ios") {
    return (
      "configuration" in left &&
      "configuration" in right &&
      left.configuration === right.configuration &&
      left.scheme === right.scheme
    );
  }

  return (
    "variant" in left &&
    "variant" in right &&
    left.variant === right.variant &&
    left.allArch === right.allArch
  );
};

const categorizeReason = (reason: string): EvidenceCategory => {
  if (
    reason === "expoConfig" ||
    reason === "expoConfigPlugins" ||
    reason === "expoConfigExternalFile"
  ) {
    return "expo-config";
  }
  if (
    reason.startsWith("expoAutolinking") ||
    reason.startsWith("rncoreAutolinking") ||
    reason.startsWith("package:")
  ) {
    return "native-dependencies";
  }
  if (reason === "bareNativeDir") {
    return "native-project";
  }
  if (
    reason === "patchPackage" ||
    reason === "expoCNGPatches" ||
    reason === "easBuild" ||
    reason === "bareGitIgnore" ||
    reason.startsWith("packageJson:")
  ) {
    return "project-metadata";
  }
  return "other";
};

const categoriesForReasons = (reasons: unknown): EvidenceCategory[] => {
  if (!Array.isArray(reasons)) {
    return ["other"];
  }

  const categories = new Set<EvidenceCategory>();
  for (const reason of reasons) {
    if (typeof reason === "string") {
      categories.add(categorizeReason(reason));
    }
  }

  if (categories.size === 0) {
    categories.add("other");
  }
  return EVIDENCE_CATEGORIES.filter((category) => categories.has(category));
};

const getComparatorIdentity = (source: RawFingerprintSource): string | null => {
  if (source.type === "contents") {
    return isBoundedString(source.id, MAX_IDENTITY_LENGTH) ? source.id : null;
  }

  const identity =
    typeof source.overrideHashKey === "string"
      ? source.overrideHashKey
      : source.filePath;
  return isBoundedString(identity, MAX_IDENTITY_LENGTH) ? identity : null;
};

const getSafeDisplayPath = (
  projectRoot: string,
  source: RawFingerprintSource
): string | undefined => {
  if (
    source.type === "contents" ||
    !isBoundedString(source.filePath, MAX_IDENTITY_LENGTH)
  ) {
    return undefined;
  }

  const resolvedRoot = path.resolve(projectRoot);
  const candidate = path.resolve(resolvedRoot, source.filePath);
  if (!isPathInside(resolvedRoot, candidate)) {
    return undefined;
  }

  try {
    const rootRealPath = fs.realpathSync(resolvedRoot);
    const candidateStats = fs.lstatSync(candidate);
    if (candidateStats.isSymbolicLink()) {
      return undefined;
    }
    if (!isPathInside(rootRealPath, fs.realpathSync(candidate))) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const relative = path.relative(resolvedRoot, candidate);
  if (
    relative.length === 0 ||
    relative.length > MAX_INSIGHT_DISPLAY_PATH_LENGTH ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    hasControlCharacters(relative)
  ) {
    return undefined;
  }

  return relative.split(path.sep).join("/");
};

const normalizeDigest = (hash: unknown): string | null | undefined => {
  if (hash === null) {
    return null;
  }
  return typeof hash === "string" &&
    hash.length > 0 &&
    hash.length <= MAX_HASH_LENGTH &&
    /^[a-fA-F0-9]+$/.test(hash)
    ? hash.toLowerCase()
    : undefined;
};

export const sanitizeFingerprintSources = (
  projectRoot: string,
  sources: readonly RawFingerprintSource[]
): InsightSource[] | null => {
  if (sources.length > MAX_INSIGHT_SOURCES) {
    return null;
  }

  const occurrences = new Map<string, number>();
  const sanitized: InsightSource[] = [];

  for (const source of sources) {
    if (
      !isRecord(source) ||
      (source.type !== "file" &&
        source.type !== "dir" &&
        source.type !== "contents")
    ) {
      return null;
    }

    const identity = getComparatorIdentity(source);
    if (identity === null) {
      return null;
    }

    const comparatorHash = crypto
      .createHash("sha256")
      .update(source.type)
      .update("\0")
      .update(identity)
      .digest("hex");
    const occurrenceKey = `${source.type}\0${comparatorHash}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);

    const displayPath = getSafeDisplayPath(projectRoot, source);
    const digest = normalizeDigest(source.hash);
    if (digest === undefined) {
      return null;
    }
    sanitized.push({
      type: source.type,
      comparatorHash,
      occurrence,
      ...(displayPath === undefined ? {} : { displayPath }),
      digest,
      categories: categoriesForReasons(source.reasons),
    });
  }

  return sanitized;
};

const isRunProfile = (
  platform: CachePlatform,
  value: unknown
): value is RunProfile => {
  if (!isRecord(value)) {
    return false;
  }

  if (platform === "ios") {
    return (
      hasOnlyKeys(value, ["configuration", "scheme"]) &&
      (value.configuration === "Debug" || value.configuration === "Release") &&
      isBoundedString(value.scheme, MAX_PROFILE_VALUE_LENGTH)
    );
  }

  return (
    hasOnlyKeys(value, ["variant", "allArch"]) &&
    isBoundedString(value.variant, MAX_PROFILE_VALUE_LENGTH) &&
    typeof value.allArch === "boolean"
  );
};

const isInsightSource = (value: unknown): value is InsightSource => {
  if (!isRecord(value)) {
    return false;
  }
  const categories = value.categories;
  if (
    !Array.isArray(categories) ||
    categories.length < 1 ||
    categories.length > EVIDENCE_CATEGORIES.length ||
    !categories.every(isEvidenceCategory) ||
    new Set(categories).size !== categories.length ||
    !EVIDENCE_CATEGORIES.filter((category) =>
      categories.includes(category)
    ).every((category, index) => category === categories[index])
  ) {
    return false;
  }
  const allowedKeys = [
    "type",
    "comparatorHash",
    "occurrence",
    "displayPath",
    "digest",
    "categories",
  ];
  const displayPath = value.displayPath;
  const normalizedDisplayPath =
    typeof displayPath === "string" ? path.posix.normalize(displayPath) : null;
  return (
    hasOnlyKeys(value, allowedKeys) &&
    (value.type === "file" ||
      value.type === "dir" ||
      value.type === "contents") &&
    typeof value.comparatorHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.comparatorHash) &&
    Number.isSafeInteger(value.occurrence) &&
    (value.occurrence as number) >= 0 &&
    (displayPath === undefined ||
      (isBoundedString(displayPath, MAX_INSIGHT_DISPLAY_PATH_LENGTH) &&
        !displayPath.includes("\\") &&
        !path.posix.isAbsolute(displayPath) &&
        normalizedDisplayPath === displayPath &&
        displayPath !== "." &&
        displayPath !== ".." &&
        !displayPath.startsWith("../"))) &&
    (value.digest === null ||
      (typeof value.digest === "string" &&
        value.digest.length > 0 &&
        value.digest.length <= MAX_HASH_LENGTH &&
        /^[a-f0-9]+$/.test(value.digest)))
  );
};

const isArtifactReadyEstimate = (
  value: unknown
): value is ArtifactReadyEstimate =>
  isRecord(value) &&
  hasOnlyKeys(value, ["durationMs", "method"]) &&
  typeof value.durationMs === "number" &&
  Number.isSafeInteger(value.durationMs) &&
  value.durationMs >= 0 &&
  value.durationMs <= 6 * 60 * 60 * 1000 &&
  value.method === "artifact-mtime-v1";

export const isCacheInsight = (value: unknown): value is CacheInsight => {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = [
    "schemaVersion",
    "platform",
    "entryId",
    "fingerprintHash",
    "capturedAt",
    "fingerprintEngineVersion",
    "runProfile",
    "sources",
    "artifactReadyEstimate",
  ];
  if (
    !hasOnlyKeys(value, allowedKeys) ||
    value.schemaVersion !== INSIGHT_SCHEMA_VERSION ||
    !isCachePlatform(value.platform) ||
    typeof value.entryId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.entryId) ||
    !isBoundedString(value.fingerprintHash, MAX_HASH_LENGTH) ||
    !isIsoTimestamp(value.capturedAt) ||
    !isBoundedString(
      value.fingerprintEngineVersion,
      MAX_ENGINE_VERSION_LENGTH
    ) ||
    !isRunProfile(value.platform, value.runProfile) ||
    !Array.isArray(value.sources) ||
    value.sources.length > MAX_INSIGHT_SOURCES ||
    !value.sources.every(isInsightSource) ||
    (value.artifactReadyEstimate !== undefined &&
      !isArtifactReadyEstimate(value.artifactReadyEstimate))
  ) {
    return false;
  }

  const occurrences = new Map<string, number>();
  for (const source of value.sources) {
    const key = `${source.type}\0${source.comparatorHash}`;
    const expected = occurrences.get(key) ?? 0;
    if (source.occurrence !== expected) {
      return false;
    }
    occurrences.set(key, expected + 1);
  }

  return true;
};

export const createCacheInsight = (
  snapshot: FingerprintSnapshot,
  entryId: string,
  artifactReadyEstimate?: ArtifactReadyEstimate
): CacheInsight => {
  const insight: CacheInsight = {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    ...snapshot,
    entryId,
    ...(artifactReadyEstimate === undefined ? {} : { artifactReadyEstimate }),
  };
  if (!isCacheInsight(insight)) {
    throw new Error("Could not create a valid cache insight");
  }
  if (Buffer.byteLength(JSON.stringify(insight), "utf8") > MAX_INSIGHT_BYTES) {
    throw new Error("Cache insight exceeds the 1 MiB limit");
  }
  return insight;
};

export const serializeCacheInsight = (insight: CacheInsight): string => {
  if (!isCacheInsight(insight)) {
    throw new Error("Cannot serialize a malformed cache insight");
  }
  const serialized = `${JSON.stringify(insight, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_INSIGHT_BYTES) {
    throw new Error("Cache insight exceeds the 1 MiB limit");
  }
  return serialized;
};

export const writeInsightAtomically = (
  entryDirectory: string,
  insight: CacheInsight
): void => {
  const serialized = serializeCacheInsight(insight);
  const finalPath = path.join(entryDirectory, INSIGHT_FILENAME);
  const temporaryPath = path.join(
    entryDirectory,
    `.insight-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let descriptor: number | undefined;

  try {
    try {
      fs.lstatSync(finalPath);
      throw new Error("Cache insight already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, finalPath);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // Preserve the original write error.
      }
    }
    throw error;
  }
};

export const readInsight = (entryDirectory: string): CacheInsight | null => {
  const insightPath = path.join(entryDirectory, INSIGHT_FILENAME);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      insightPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let contents: string;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("Cache insight must be a regular file");
    }
    if (stats.size > MAX_INSIGHT_BYTES) {
      throw new Error("Cache insight exceeds the 1 MiB limit");
    }
    contents = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }

  const parsed: unknown = JSON.parse(contents);
  if (!isCacheInsight(parsed)) {
    throw new Error("Unsupported or malformed cache insight");
  }
  return parsed;
};

const sourceKey = (source: InsightSource): string =>
  `${source.type}\0${source.comparatorHash}\0${source.occurrence}`;

const primaryCategory = (
  before: InsightSource | undefined,
  after: InsightSource | undefined
): EvidenceCategory => {
  const categories = new Set([
    ...(before?.categories ?? []),
    ...(after?.categories ?? []),
  ]);
  return (
    EVIDENCE_CATEGORIES.find((category) => categories.has(category)) ?? "other"
  );
};

export const diffInsights = (
  before: Pick<CacheInsight, "sources">,
  after: Pick<CacheInsight, "sources">
): InsightDiff => {
  const beforeByKey = new Map(
    before.sources.map((source) => [sourceKey(source), source])
  );
  const afterByKey = new Map(
    after.sources.map((source) => [sourceKey(source), source])
  );
  const items: InsightDiffItem[] = [];

  for (const source of before.sources) {
    const key = sourceKey(source);
    const next = afterByKey.get(key);
    if (next === undefined) {
      items.push({
        operation: "removed",
        category: primaryCategory(source, undefined),
        before: source,
      });
    } else if (source.digest !== next.digest) {
      items.push({
        operation: "changed",
        category: primaryCategory(source, next),
        before: source,
        after: next,
      });
    }
  }

  for (const source of after.sources) {
    if (!beforeByKey.has(sourceKey(source))) {
      items.push({
        operation: "added",
        category: primaryCategory(undefined, source),
        after: source,
      });
    }
  }

  const groups = EVIDENCE_CATEGORIES.map((category) => ({
    category,
    count: items.filter((item) => item.category === category).length,
  }))
    .filter((group) => group.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        EVIDENCE_CATEGORIES.indexOf(left.category) -
          EVIDENCE_CATEGORIES.indexOf(right.category)
    );
  const added = items.filter((item) => item.operation === "added").length;
  const removed = items.filter((item) => item.operation === "removed").length;
  const changed = items.filter((item) => item.operation === "changed").length;

  return {
    items,
    added,
    removed,
    changed,
    total: added + removed + changed,
    groups,
  };
};

export const getTopEvidenceGroups = (
  diff: Pick<InsightDiff, "groups">
): InsightDiff["groups"] => diff.groups.slice(0, 3);

const timestampValue = (value: string | null | undefined): number => {
  const parsed =
    value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const selectClosestInsight = (
  current: FingerprintSnapshot,
  candidates: readonly InsightCandidate[]
): ClosestInsightResult => {
  if (candidates.length === 0) {
    return { status: "no-candidate", candidate: null, diff: null };
  }

  const profileCandidates = candidates.filter(
    (candidate) =>
      candidate.insight.platform === current.platform &&
      runProfilesEqual(
        current.platform,
        candidate.insight.runProfile,
        current.runProfile
      )
  );
  if (profileCandidates.length === 0) {
    return {
      status: "no-compatible-profile",
      candidate: null,
      diff: null,
    };
  }

  const engineCandidates = profileCandidates.filter(
    (candidate) =>
      candidate.insight.fingerprintEngineVersion ===
      current.fingerprintEngineVersion
  );
  if (engineCandidates.length === 0) {
    return {
      status: "fingerprint-engine-mismatch",
      candidate: null,
      diff: null,
    };
  }

  const ranked = engineCandidates.map((candidate) => ({
    candidate,
    diff: diffInsights(candidate.insight, current),
  }));
  ranked.sort(
    (left, right) =>
      left.diff.total - right.diff.total ||
      timestampValue(right.candidate.lastAccessAt) -
        timestampValue(left.candidate.lastAccessAt) ||
      timestampValue(right.candidate.createdAt) -
        timestampValue(left.candidate.createdAt) ||
      left.candidate.entryId.localeCompare(right.candidate.entryId)
  );

  const closest = ranked[0];
  if (closest === undefined) {
    return { status: "no-candidate", candidate: null, diff: null };
  }
  return { status: "match", ...closest };
};
