import * as path from "path";

import { assertManagedDirectory } from "./filesystem";
import { inspectArtifact, inspectPayloadFile } from "./integrity";
import type { CacheManifest } from "./manifest";
import { readManifest } from "./manifest";
import { getArtifactName, getEntryId, type CachePlatform } from "./paths";

export type CacheValidationResult =
  | {
      valid: true;
      artifactPath: string | null;
      payloadPath: string | null;
      manifest: CacheManifest;
    }
  | { valid: false; reason: string };

export const validateEntry = (
  entryDirectory: string,
  providerRoot: string,
  platform: CachePlatform,
  fingerprintHash: string,
  entryId: string,
  options: { deadlineMs?: number } = {}
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

    if (manifest.schemaVersion === 2) {
      const payloadPath = path.join(
        entryDirectory,
        manifest.payload.relativePath
      );
      if (path.dirname(payloadPath) !== path.resolve(entryDirectory)) {
        return { valid: false, reason: "payload path escapes the entry" };
      }
      const payload = inspectPayloadFile(
        payloadPath,
        manifest.payload.sizeBytes,
        options
      );
      if (
        payload.sizeBytes !== manifest.payload.sizeBytes ||
        payload.digest !== manifest.payload.integrity.digest
      ) {
        return {
          valid: false,
          reason: "compressed payload integrity mismatch",
        };
      }
      return { valid: true, artifactPath: null, payloadPath, manifest };
    }

    const artifactPath = path.join(entryDirectory, expectedArtifactName);
    if (path.dirname(artifactPath) !== path.resolve(entryDirectory)) {
      return { valid: false, reason: "artifact path escapes the entry" };
    }

    const integrity = inspectArtifact(
      artifactPath,
      platform,
      {
        sizeBytes: manifest.artifact.sizeBytes,
        fileCount: manifest.artifact.fileCount,
      },
      options
    );
    if (
      integrity.algorithm !== manifest.artifact.integrity.algorithm ||
      integrity.digest !== manifest.artifact.integrity.digest ||
      integrity.sizeBytes !== manifest.artifact.sizeBytes ||
      integrity.fileCount !== manifest.artifact.fileCount
    ) {
      return { valid: false, reason: "artifact integrity mismatch" };
    }

    return { valid: true, artifactPath, payloadPath: null, manifest };
  } catch (error) {
    return {
      valid: false,
      reason:
        error instanceof Error ? error.message : "unknown validation error",
    };
  }
};
