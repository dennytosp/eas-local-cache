import type { ToolchainMode } from "../options";
import type { CachePlatform } from "../paths";

export const INSIGHT_SCHEMA_VERSION = 2;
export const INSIGHT_FILENAME = "insight.json";
export const MAX_INSIGHT_BYTES = 1024 * 1024;
export const MAX_INSIGHT_SOURCES = 10_000;
export const MAX_INSIGHT_DISPLAY_PATH_LENGTH = 256;

export const MAX_IDENTITY_LENGTH = 16_384;
export const MAX_HASH_LENGTH = 256;
export const MAX_ENGINE_VERSION_LENGTH = 128;
export const MAX_PROFILE_VALUE_LENGTH = 256;
export const MAX_TOOLCHAIN_VALUE_LENGTH = 128;

export const HOST_ARCHITECTURES = ["arm64", "x86_64", "x86", "arm"] as const;
export const JAVA_VENDOR_FAMILIES = [
  "adoptium",
  "amazon",
  "azul",
  "microsoft",
  "oracle",
  "other",
] as const;
export const JAVA_VM_FAMILIES = [
  "hotspot",
  "openj9",
  "graalvm",
  "other",
] as const;
export const ANDROID_TARGET_ARCHITECTURES = [
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
