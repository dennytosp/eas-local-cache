import * as path from "path";

import { assertManagedDirectory } from "./filesystem";
import { inspectArtifact } from "./integrity";
import type { CacheManifest } from "./manifest";
import { readManifest } from "./manifest";
import { getArtifactName, getEntryId, type CachePlatform } from "./paths";

export type CacheValidationResult =
  | { valid: true; artifactPath: string; manifest: CacheManifest }
  | { valid: false; reason: string };

export const validateEntry = (
  entryDirectory: string,
  providerRoot: string,
  platform: CachePlatform,
  fingerprintHash: string,
  entryId: string
): CacheValidationResult => {
  try {
    assertManagedDirectory(providerRoot, entryDirectory);
    const manifest = readManifest(entryDirectory);
    const expectedArtifactName = getArtifactName(platform);
    const expectedType = platform === "ios" ? "directory" : "file";

    if (
      manifest.platform !== platform ||
      manifest.fingerprintHash !== fingerprintHash ||
      manifest.entryId !== entryId ||
      getEntryId(platform, fingerprintHash) !== entryId ||
      manifest.artifact.relativePath !== expectedArtifactName ||
      manifest.artifact.type !== expectedType
    ) {
      return { valid: false, reason: "manifest identity mismatch" };
    }

    const artifactPath = path.join(entryDirectory, expectedArtifactName);
    if (path.dirname(artifactPath) !== path.resolve(entryDirectory)) {
      return { valid: false, reason: "artifact path escapes the entry" };
    }

    const integrity = inspectArtifact(artifactPath, platform);
    if (
      integrity.algorithm !== manifest.artifact.integrity.algorithm ||
      integrity.digest !== manifest.artifact.integrity.digest ||
      integrity.sizeBytes !== manifest.artifact.sizeBytes ||
      integrity.fileCount !== manifest.artifact.fileCount
    ) {
      return { valid: false, reason: "artifact integrity mismatch" };
    }

    return { valid: true, artifactPath, manifest };
  } catch (error) {
    return {
      valid: false,
      reason:
        error instanceof Error ? error.message : "unknown validation error",
    };
  }
};
