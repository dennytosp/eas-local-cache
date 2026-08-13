import * as path from "path";

import { TOOLCHAIN_MODES, type ToolchainMode } from "../options";
import type { CachePlatform } from "../paths";
import {
  hasOnlyKeys,
  isBoundedString,
  isCachePlatform,
  isEvidenceCategory,
  isIsoTimestamp,
  isRecord,
} from "./validation-helpers";
import {
  ANDROID_TARGET_ARCHITECTURES,
  type AndroidToolchainSnapshot,
  EVIDENCE_CATEGORIES,
  HOST_ARCHITECTURES,
  INSIGHT_SCHEMA_VERSION,
  INSIGHT_KEY_SCHEMAS,
  type InsightKeySchema,
  type IosToolchainSnapshot,
  JAVA_VENDOR_FAMILIES,
  JAVA_VM_FAMILIES,
  MAX_ENGINE_VERSION_LENGTH,
  MAX_HASH_LENGTH,
  MAX_INSIGHT_DISPLAY_PATH_LENGTH,
  MAX_INSIGHT_SOURCES,
  MAX_PROFILE_VALUE_LENGTH,
  MAX_TOOLCHAIN_VALUE_LENGTH,
  type ArtifactReadyEstimate,
  type CacheInsight,
  type InsightIdentity,
  type InsightSource,
  type InsightToolchainSnapshot,
  type RunProfile,
} from "./types";

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
