import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { isPathInside } from "../filesystem";
import type { CachePlatform } from "../paths";
import {
  hasControlCharacters,
  isBoundedString,
  isRecord,
  normalizeProfileValue,
} from "./validation-helpers";
import {
  MAX_HASH_LENGTH,
  MAX_IDENTITY_LENGTH,
  MAX_INSIGHT_DISPLAY_PATH_LENGTH,
  MAX_INSIGHT_SOURCES,
  type EvidenceCategory,
  EVIDENCE_CATEGORIES,
  type InsightSource,
  type RawFingerprintSource,
  type RunProfile,
} from "./types";

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
