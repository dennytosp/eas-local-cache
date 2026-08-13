import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { isPathInside } from "./filesystem";
import { TOOLCHAIN_MODES, type ToolchainMode } from "./options";
import type { CachePlatform } from "./paths";

export const INSIGHT_SCHEMA_VERSION = 2;
export const INSIGHT_FILENAME = "insight.json";
export const MAX_INSIGHT_BYTES = 1024 * 1024;
export const MAX_INSIGHT_SOURCES = 10_000;
export const MAX_INSIGHT_DISPLAY_PATH_LENGTH = 256;

const MAX_IDENTITY_LENGTH = 16_384;
const MAX_HASH_LENGTH = 256;
const MAX_ENGINE_VERSION_LENGTH = 128;
const MAX_PROFILE_VALUE_LENGTH = 256;
const MAX_TOOLCHAIN_VALUE_LENGTH = 128;

const HOST_ARCHITECTURES = ["arm64", "x86_64", "x86", "arm"] as const;
const JAVA_VENDOR_FAMILIES = [
  "adoptium",
  "amazon",
  "azul",
  "microsoft",
  "oracle",
  "other",
] as const;
const JAVA_VM_FAMILIES = ["hotspot", "openj9", "graalvm", "other"] as const;
const ANDROID_TARGET_ARCHITECTURES = [
  "all",
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
] as const;

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

export const INSIGHT_KEY_SCHEMAS = ["expo-base", "environment-v1"] as const;
export type InsightKeySchema = (typeof INSIGHT_KEY_SCHEMAS)[number];

export type IosToolchainSnapshot = {
  platform: "ios";
  hostArch: string;
  xcodeBuildVersion: string;
  simulatorSdkBuildVersion: string;
  xcodeVersion?: string;
  simulatorSdkVersion?: string;
};

export type AndroidToolchainSnapshot = {
  platform: "android";
  hostArch: string;
  compileSdkVersion?: string;
  androidSdkPlatformRevision?: string;
  buildToolsVersion?: string;
  javaSpecificationVersion: string;
  javaVendorFamily: string;
  jvmArch: string;
  gradleVersion: string;
  targetArchitecture: string;
  javaRuntimeVersion?: string;
  vmFamily?: string;
  gradleDistributionBasename?: string;
  gradleDistributionSha256?: string;
};

export type InsightToolchainSnapshot =
  | IosToolchainSnapshot
  | AndroidToolchainSnapshot;

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
  baseFingerprintHash?: string;
  effectiveFingerprintHash?: string;
  keySchema?: InsightKeySchema;
  toolchainMode?: ToolchainMode;
  toolchain?: InsightToolchainSnapshot | null;
  environmentKeyDigest?: string | null;
  capturedAt: string;
  fingerprintEngineVersion: string;
  runProfile: RunProfile;
  sources: InsightSource[];
};

export type ArtifactReadyEstimate = {
  durationMs: number;
  method: "artifact-mtime-v1";
};

export type CacheInsightV1 = Omit<
  FingerprintSnapshot,
  | "baseFingerprintHash"
  | "effectiveFingerprintHash"
  | "keySchema"
  | "toolchainMode"
  | "toolchain"
  | "environmentKeyDigest"
> & {
  schemaVersion: 1;
  entryId: string;
  artifactReadyEstimate?: ArtifactReadyEstimate;
};

export type CacheInsightV2 = Omit<
  FingerprintSnapshot,
  | "baseFingerprintHash"
  | "effectiveFingerprintHash"
  | "keySchema"
  | "toolchainMode"
  | "toolchain"
  | "environmentKeyDigest"
> & {
  schemaVersion: 2;
  entryId: string;
  baseFingerprintHash: string;
  effectiveFingerprintHash: string;
  keySchema: InsightKeySchema;
  toolchainMode: ToolchainMode;
  toolchain: InsightToolchainSnapshot | null;
  environmentKeyDigest: string | null;
  artifactReadyEstimate?: ArtifactReadyEstimate;
};

export type CacheInsight = CacheInsightV1 | CacheInsightV2;

export type InsightIdentity = {
  fingerprintHash: string;
  baseFingerprintHash: string;
  effectiveFingerprintHash: string;
  keySchema: InsightKeySchema;
  toolchainMode: ToolchainMode;
  toolchain: InsightToolchainSnapshot | null;
  environmentKeyDigest: string | null;
};

export const ENVIRONMENT_EVIDENCE_CATEGORIES = [
  "build-profile",
  "xcode",
  "platform-sdk",
  "jdk",
  "gradle",
  "architecture",
  "manual-environment",
  "key-schema",
] as const;

export type EnvironmentEvidenceCategory =
  (typeof ENVIRONMENT_EVIDENCE_CATEGORIES)[number];

export type EnvironmentDiffItem = {
  field: string;
  category: EnvironmentEvidenceCategory;
};

export type EnvironmentDiff = {
  items: EnvironmentDiffItem[];
  total: number;
  groups: Array<{ category: EnvironmentEvidenceCategory; count: number }>;
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
      environmentDiff: EnvironmentDiff;
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

const isToolchainValue = (value: unknown): value is string =>
  isBoundedString(value, MAX_TOOLCHAIN_VALUE_LENGTH) &&
  /^[a-zA-Z0-9][a-zA-Z0-9._+()-]*$/.test(value);

const isEnumValue = <T extends string>(
  values: readonly T[],
  value: unknown
): value is T => values.includes(value as T);

const isIosToolchainSnapshot = (
  value: unknown
): value is IosToolchainSnapshot =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "platform",
    "hostArch",
    "xcodeBuildVersion",
    "simulatorSdkBuildVersion",
    "xcodeVersion",
    "simulatorSdkVersion",
  ]) &&
  value.platform === "ios" &&
  isEnumValue(HOST_ARCHITECTURES, value.hostArch) &&
  isToolchainValue(value.xcodeBuildVersion) &&
  isToolchainValue(value.simulatorSdkBuildVersion) &&
  (value.xcodeVersion === undefined || isToolchainValue(value.xcodeVersion)) &&
  (value.simulatorSdkVersion === undefined ||
    isToolchainValue(value.simulatorSdkVersion));

const isAndroidToolchainSnapshot = (
  value: unknown
): value is AndroidToolchainSnapshot =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "platform",
    "hostArch",
    "compileSdkVersion",
    "androidSdkPlatformRevision",
    "buildToolsVersion",
    "javaSpecificationVersion",
    "javaVendorFamily",
    "jvmArch",
    "gradleVersion",
    "targetArchitecture",
    "javaRuntimeVersion",
    "vmFamily",
    "gradleDistributionBasename",
    "gradleDistributionSha256",
  ]) &&
  value.platform === "android" &&
  isEnumValue(HOST_ARCHITECTURES, value.hostArch) &&
  ((value.compileSdkVersion === undefined &&
    value.androidSdkPlatformRevision === undefined &&
    value.buildToolsVersion === undefined) ||
    (isToolchainValue(value.compileSdkVersion) &&
      /^[0-9]{1,3}$/.test(value.compileSdkVersion) &&
      isToolchainValue(value.androidSdkPlatformRevision) &&
      isToolchainValue(value.buildToolsVersion))) &&
  isToolchainValue(value.javaSpecificationVersion) &&
  isEnumValue(JAVA_VENDOR_FAMILIES, value.javaVendorFamily) &&
  isEnumValue(HOST_ARCHITECTURES, value.jvmArch) &&
  isToolchainValue(value.gradleVersion) &&
  isEnumValue(ANDROID_TARGET_ARCHITECTURES, value.targetArchitecture) &&
  (value.javaRuntimeVersion === undefined ||
    isToolchainValue(value.javaRuntimeVersion)) &&
  (value.vmFamily === undefined ||
    isEnumValue(JAVA_VM_FAMILIES, value.vmFamily)) &&
  (value.gradleDistributionBasename === undefined ||
    isToolchainValue(value.gradleDistributionBasename)) &&
  (value.gradleDistributionSha256 === undefined ||
    (typeof value.gradleDistributionSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.gradleDistributionSha256)));

const isToolchainSnapshot = (
  platform: CachePlatform,
  value: unknown
): value is InsightToolchainSnapshot =>
  platform === "ios"
    ? isIosToolchainSnapshot(value)
    : isAndroidToolchainSnapshot(value);

const isToolchainSnapshotForMode = (
  platform: CachePlatform,
  mode: Exclude<ToolchainMode, "off">,
  value: unknown
): value is InsightToolchainSnapshot => {
  if (!isToolchainSnapshot(platform, value)) {
    return false;
  }

  if (value.platform === "ios") {
    return mode === "strict"
      ? value.xcodeVersion !== undefined &&
          value.simulatorSdkVersion !== undefined
      : value.xcodeVersion === undefined &&
          value.simulatorSdkVersion === undefined;
  }

  return mode === "strict"
    ? value.javaRuntimeVersion !== undefined &&
        value.vmFamily !== undefined &&
        value.gradleDistributionBasename !== undefined
    : value.javaRuntimeVersion === undefined &&
        value.vmFamily === undefined &&
        value.gradleDistributionBasename === undefined &&
        value.gradleDistributionSha256 === undefined;
};

const isCacheInsightCommon = (value: Record<string, unknown>): boolean =>
  isCachePlatform(value.platform) &&
  typeof value.entryId === "string" &&
  /^[a-f0-9]{64}$/.test(value.entryId) &&
  isBoundedString(value.fingerprintHash, MAX_HASH_LENGTH) &&
  isIsoTimestamp(value.capturedAt) &&
  isBoundedString(value.fingerprintEngineVersion, MAX_ENGINE_VERSION_LENGTH) &&
  isRunProfile(value.platform, value.runProfile) &&
  Array.isArray(value.sources) &&
  value.sources.length <= MAX_INSIGHT_SOURCES &&
  value.sources.every(isInsightSource) &&
  (value.artifactReadyEstimate === undefined ||
    isArtifactReadyEstimate(value.artifactReadyEstimate));

const hasSequentialSourceOccurrences = (
  sources: readonly InsightSource[]
): boolean => {
  const occurrences = new Map<string, number>();
  for (const source of sources) {
    const key = `${source.type}\0${source.comparatorHash}`;
    const expected = occurrences.get(key) ?? 0;
    if (source.occurrence !== expected) {
      return false;
    }
    occurrences.set(key, expected + 1);
  }
  return true;
};

const isCacheInsightV1 = (value: Record<string, unknown>): boolean => {
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
  return (
    value.schemaVersion === 1 &&
    hasOnlyKeys(value, allowedKeys) &&
    isCacheInsightCommon(value) &&
    hasSequentialSourceOccurrences(value.sources as InsightSource[])
  );
};

const isCacheInsightV2 = (value: Record<string, unknown>): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = [
    "schemaVersion",
    "platform",
    "entryId",
    "fingerprintHash",
    "baseFingerprintHash",
    "effectiveFingerprintHash",
    "keySchema",
    "toolchainMode",
    "toolchain",
    "environmentKeyDigest",
    "capturedAt",
    "fingerprintEngineVersion",
    "runProfile",
    "sources",
    "artifactReadyEstimate",
  ];
  if (
    !hasOnlyKeys(value, allowedKeys) ||
    value.schemaVersion !== INSIGHT_SCHEMA_VERSION ||
    !isCacheInsightCommon(value) ||
    !isBoundedString(value.baseFingerprintHash, MAX_HASH_LENGTH) ||
    !isBoundedString(value.effectiveFingerprintHash, MAX_HASH_LENGTH) ||
    value.fingerprintHash !== value.effectiveFingerprintHash ||
    !INSIGHT_KEY_SCHEMAS.includes(value.keySchema as InsightKeySchema) ||
    !TOOLCHAIN_MODES.includes(value.toolchainMode as ToolchainMode) ||
    (value.environmentKeyDigest !== null &&
      (typeof value.environmentKeyDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.environmentKeyDigest)))
  ) {
    return false;
  }

  if (
    value.keySchema === "expo-base" &&
    (value.baseFingerprintHash !== value.effectiveFingerprintHash ||
      value.toolchainMode !== "off" ||
      value.toolchain !== null ||
      value.environmentKeyDigest !== null)
  ) {
    return false;
  }

  if (
    value.keySchema === "environment-v1" &&
    (!/^elc-env-v1:[a-f0-9]{64}$/.test(
      value.effectiveFingerprintHash as string
    ) ||
      (value.toolchainMode === "off" &&
        (value.toolchain !== null || value.environmentKeyDigest === null)) ||
      (value.toolchainMode !== "off" &&
        !isToolchainSnapshotForMode(
          value.platform as CachePlatform,
          value.toolchainMode as Exclude<ToolchainMode, "off">,
          value.toolchain
        )))
  ) {
    return false;
  }

  return hasSequentialSourceOccurrences(value.sources as InsightSource[]);
};

export const isCacheInsight = (value: unknown): value is CacheInsight =>
  isRecord(value) && (isCacheInsightV1(value) || isCacheInsightV2(value));

export const getInsightIdentity = (insight: CacheInsight): InsightIdentity => {
  if (insight.schemaVersion === 1) {
    return {
      fingerprintHash: insight.fingerprintHash,
      baseFingerprintHash: insight.fingerprintHash,
      effectiveFingerprintHash: insight.fingerprintHash,
      keySchema: "expo-base",
      toolchainMode: "off",
      toolchain: null,
      environmentKeyDigest: null,
    };
  }

  return {
    fingerprintHash: insight.fingerprintHash,
    baseFingerprintHash: insight.baseFingerprintHash,
    effectiveFingerprintHash: insight.effectiveFingerprintHash,
    keySchema: insight.keySchema,
    toolchainMode: insight.toolchainMode,
    toolchain: insight.toolchain,
    environmentKeyDigest: insight.environmentKeyDigest,
  };
};

export const createCacheInsight = (
  snapshot: FingerprintSnapshot,
  entryId: string,
  artifactReadyEstimate?: ArtifactReadyEstimate
): CacheInsightV2 => {
  const usesEnvironmentIdentity =
    snapshot.keySchema !== undefined ||
    snapshot.baseFingerprintHash !== undefined ||
    snapshot.effectiveFingerprintHash !== undefined ||
    snapshot.toolchainMode !== undefined ||
    snapshot.toolchain !== undefined ||
    snapshot.environmentKeyDigest !== undefined;
  const keySchema = snapshot.keySchema ?? "expo-base";
  const baseFingerprintHash =
    snapshot.baseFingerprintHash ?? snapshot.fingerprintHash;
  const effectiveFingerprintHash =
    snapshot.effectiveFingerprintHash ?? snapshot.fingerprintHash;
  const toolchainMode = snapshot.toolchainMode ?? "off";
  const toolchain = snapshot.toolchain ?? null;
  const environmentKeyDigest = snapshot.environmentKeyDigest ?? null;

  const insight: CacheInsightV2 = {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    platform: snapshot.platform,
    entryId,
    fingerprintHash: snapshot.fingerprintHash,
    baseFingerprintHash,
    effectiveFingerprintHash,
    keySchema,
    toolchainMode,
    toolchain,
    environmentKeyDigest,
    capturedAt: snapshot.capturedAt,
    fingerprintEngineVersion: snapshot.fingerprintEngineVersion,
    runProfile: snapshot.runProfile,
    sources: snapshot.sources,
    ...(artifactReadyEstimate === undefined ? {} : { artifactReadyEstimate }),
  };
  if (
    usesEnvironmentIdentity &&
    (snapshot.baseFingerprintHash === undefined ||
      snapshot.effectiveFingerprintHash === undefined ||
      snapshot.keySchema === undefined ||
      snapshot.toolchainMode === undefined)
  ) {
    throw new Error("Environment-aware insight identity is incomplete");
  }
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

const environmentCategoryForField = (
  field: string
): EnvironmentEvidenceCategory => {
  if (field.startsWith("runProfile.")) return "build-profile";
  if (field === "xcodeBuildVersion" || field === "xcodeVersion") return "xcode";
  if (
    field === "simulatorSdkBuildVersion" ||
    field === "simulatorSdkVersion" ||
    field === "compileSdkVersion" ||
    field === "androidSdkPlatformRevision" ||
    field === "buildToolsVersion"
  )
    return "platform-sdk";
  if (
    field === "javaSpecificationVersion" ||
    field === "javaVendorFamily" ||
    field === "javaRuntimeVersion" ||
    field === "vmFamily"
  )
    return "jdk";
  if (field.startsWith("gradle")) return "gradle";
  if (
    field === "hostArch" ||
    field === "jvmArch" ||
    field === "targetArchitecture"
  )
    return "architecture";
  if (field === "environmentKeyDigest") return "manual-environment";
  return "key-schema";
};

const getSnapshotIdentity = (
  snapshot: FingerprintSnapshot
): InsightIdentity => ({
  fingerprintHash: snapshot.fingerprintHash,
  baseFingerprintHash: snapshot.baseFingerprintHash ?? snapshot.fingerprintHash,
  effectiveFingerprintHash:
    snapshot.effectiveFingerprintHash ?? snapshot.fingerprintHash,
  keySchema: snapshot.keySchema ?? "expo-base",
  toolchainMode: snapshot.toolchainMode ?? "off",
  toolchain: snapshot.toolchain ?? null,
  environmentKeyDigest: snapshot.environmentKeyDigest ?? null,
});

const flattenedEnvironment = (
  profile: RunProfile,
  identity: InsightIdentity
): Map<string, string | null> => {
  const fields = new Map<string, string | null>();
  for (const [key, value] of Object.entries(profile).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    fields.set(`runProfile.${key}`, String(value));
  }
  fields.set("keySchema", identity.keySchema);
  fields.set("toolchainMode", identity.toolchainMode);
  fields.set("environmentKeyDigest", identity.environmentKeyDigest);
  if (identity.toolchain !== null) {
    for (const [key, value] of Object.entries(identity.toolchain).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      if (key !== "platform") fields.set(key, value ?? null);
    }
  }
  return fields;
};

export const diffInsightEnvironment = (
  before: CacheInsight,
  after: FingerprintSnapshot
): EnvironmentDiff => {
  const beforeIdentity = getInsightIdentity(before);
  const afterIdentity = getSnapshotIdentity(after);
  let items: EnvironmentDiffItem[];

  if (before.schemaVersion === 1 && afterIdentity.keySchema !== "expo-base") {
    items = [{ field: "keySchema", category: "key-schema" }];
  } else {
    const beforeFields = flattenedEnvironment(
      before.runProfile,
      beforeIdentity
    );
    const afterFields = flattenedEnvironment(after.runProfile, afterIdentity);
    const names = [
      ...new Set([...beforeFields.keys(), ...afterFields.keys()]),
    ].sort();
    items = names
      .filter((field) => beforeFields.get(field) !== afterFields.get(field))
      .map((field) => ({
        field,
        category: environmentCategoryForField(field),
      }));
  }

  const groups = ENVIRONMENT_EVIDENCE_CATEGORIES.map((category) => ({
    category,
    count: items.filter((item) => item.category === category).length,
  })).filter((group) => group.count > 0);
  return { items, total: items.length, groups };
};

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
    (candidate) => candidate.insight.platform === current.platform
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

  const currentIdentity = getSnapshotIdentity(current);
  const ranked = engineCandidates.map((candidate) => ({
    candidate,
    diff: diffInsights(candidate.insight, current),
    environmentDiff: diffInsightEnvironment(candidate.insight, current),
    baseFingerprintMatches:
      getInsightIdentity(candidate.insight).baseFingerprintHash ===
      currentIdentity.baseFingerprintHash,
  }));
  ranked.sort(
    (left, right) =>
      Number(right.baseFingerprintMatches) -
        Number(left.baseFingerprintMatches) ||
      left.diff.total - right.diff.total ||
      left.environmentDiff.total - right.environmentDiff.total ||
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
  return {
    status: "match",
    candidate: closest.candidate,
    diff: closest.diff,
    environmentDiff: closest.environmentDiff,
  };
};
