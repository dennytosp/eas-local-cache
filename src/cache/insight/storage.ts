import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { isCacheInsight } from "./schema";
import {
  INSIGHT_FILENAME,
  INSIGHT_SCHEMA_VERSION,
  MAX_INSIGHT_BYTES,
  type ArtifactReadyEstimate,
  type CacheInsight,
  type CacheInsightV2,
  type FingerprintSnapshot,
} from "./types";

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
