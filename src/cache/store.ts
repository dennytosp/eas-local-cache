import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { touchAccessRecord } from "./access";
import { copyArtifact, validateSourceArtifact } from "./copy";
import { prepareCompressedEntry } from "./compression";
import {
  assertManagedDirectory,
  assertProviderRoot,
  ensureManagedDirectory,
  ensureProviderRoot,
  pathExists,
} from "./filesystem";
import { inspectArtifact } from "./integrity";
import {
  INSIGHT_FILENAME,
  writeInsightAtomically,
  type CacheInsight,
} from "./insight";
import { acquireEntryLock, releaseEntryLock } from "./lock";
import {
  CACHE_SCHEMA_VERSION,
  readManifest,
  type CacheManifest,
  type CacheManifestV1,
  writeManifest,
} from "./manifest";
import {
  CachePlatform,
  getArtifactName,
  getCompressedArtifactName,
  getCachePaths,
  getEntryDirectory,
  getEntryId,
  getLegacyArtifactPath,
  getRestoreDirectory,
} from "./paths";
import { materializeCompressedArtifact } from "./restore";
import { validateEntry } from "./validation";
import type { CompressionMode } from "./options";
import type { ZstdCodec } from "./zstd";

type CacheIdentity = {
  projectRoot: string;
  platform: CachePlatform;
  fingerprintHash: string;
  codec?: ZstdCodec | null;
};

export type CacheMissReason =
  | "not-found"
  | "corrupt"
  | "lock-busy"
  | "unsafe-legacy-path"
  | "legacy-invalid"
  | "compression-unavailable";

export type CacheResolveResult =
  | {
      outcome: "hit";
      path: string;
      source: "versioned" | "legacy";
      entryDirectory: string | null;
      materializedRestore: boolean;
    }
  | {
      outcome: "miss";
      reason: CacheMissReason;
      compressedPayloadDigest?: string;
    };

const COMPRESSED_RESOLVE_WAIT_MS = 2 * 60_000;

const getPackageVersion = (): string => {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown";
  } catch {
    return "unknown";
  }
};

const quarantineEntry = (
  entryDirectory: string,
  providerRoot: string,
  quarantineRoot: string,
  platform: CachePlatform,
  entryId: string,
  reason: string,
  restoreDirectory?: string
) => {
  if (!pathExists(entryDirectory)) {
    return;
  }

  assertManagedDirectory(providerRoot, path.dirname(entryDirectory));
  ensureManagedDirectory(providerRoot, quarantineRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(
    quarantineRoot,
    `${platform}-${entryId}-${timestamp}-${crypto.randomUUID()}`
  );
  let restoreDestination: string | null = null;
  if (restoreDirectory && pathExists(restoreDirectory)) {
    assertManagedDirectory(providerRoot, path.dirname(restoreDirectory));
    restoreDestination = `${destination}-restore`;
    fs.renameSync(restoreDirectory, restoreDestination);
  }
  try {
    fs.renameSync(entryDirectory, destination);
  } catch (error) {
    if (
      restoreDestination &&
      pathExists(restoreDestination) &&
      restoreDirectory &&
      !pathExists(restoreDirectory)
    ) {
      fs.renameSync(restoreDestination, restoreDirectory);
    }
    throw error;
  }

  const metadataPath = `${destination}.json`;
  try {
    fs.writeFileSync(
      metadataPath,
      `${JSON.stringify(
        { quarantinedAt: new Date().toISOString(), reason },
        null,
        2
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    console.warn("Could not write quarantine metadata", error);
  }
};

const isLegacyArtifactValid = (
  artifactPath: string,
  platform: CachePlatform
): boolean => {
  try {
    const stats = fs.lstatSync(artifactPath);
    return platform === "ios"
      ? stats.isDirectory() &&
          (() => {
            const infoPlist = path.join(artifactPath, "Info.plist");
            const infoStats = fs.lstatSync(infoPlist);
            return infoStats.isFile() && !infoStats.isSymbolicLink();
          })()
      : stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
};

export const resolveCacheEntryDetailed = async ({
  projectRoot,
  platform,
  fingerprintHash,
  codec,
}: CacheIdentity): Promise<CacheResolveResult> => {
  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  const entryId = getEntryId(platform, fingerprintHash);
  const entryDirectory = getEntryDirectory(paths, platform, entryId);
  let versionedMissReason: CacheMissReason | null = null;

  if (pathExists(entryDirectory)) {
    assertProviderRoot(managedProjectRoot, paths.providerRoot);
    ensureManagedDirectory(paths.providerRoot, paths.locksRoot);
    let maxWaitMs = 250;
    try {
      if (readManifest(entryDirectory).schemaVersion === 2) {
        maxWaitMs = COMPRESSED_RESOLVE_WAIT_MS;
      }
    } catch {
      // Invalid entries should not extend the bounded corruption-recovery wait.
    }
    const lock = await acquireEntryLock(paths.locksRoot, entryId, {
      maxWaitMs,
      retryIntervalMs: 25,
    });
    if (lock) {
      try {
        const revalidation = validateEntry(
          entryDirectory,
          paths.providerRoot,
          platform,
          fingerprintHash,
          entryId
        );
        if (!revalidation.valid) {
          quarantineEntry(
            entryDirectory,
            paths.providerRoot,
            paths.quarantineRoot,
            platform,
            entryId,
            revalidation.reason,
            getRestoreDirectory(paths, platform, entryId)
          );
          console.warn(
            `Ignored corrupt ${platform} cache entry: ${revalidation.reason}`
          );
        } else {
          let artifactPath = revalidation.artifactPath;
          let materializedRestore = false;
          if (revalidation.manifest.schemaVersion === 2) {
            const restore = await materializeCompressedArtifact({
              paths,
              entryDirectory,
              manifest: revalidation.manifest,
              ...(codec === undefined ? {} : { codec }),
            });
            if (restore.status === "unavailable") {
              return {
                outcome: "miss",
                reason: "compression-unavailable",
                ...(restore.replaceable
                  ? {
                      compressedPayloadDigest:
                        revalidation.manifest.payload.integrity.digest,
                    }
                  : {}),
              };
            }
            if (restore.status === "invalid") {
              quarantineEntry(
                entryDirectory,
                paths.providerRoot,
                paths.quarantineRoot,
                platform,
                entryId,
                restore.reason,
                getRestoreDirectory(paths, platform, entryId)
              );
              return { outcome: "miss", reason: "corrupt" };
            }
            artifactPath = restore.artifactPath;
            materializedRestore = restore.created;
          }
          try {
            touchAccessRecord(paths.accessRoot, entryId, platform, {
              providerRoot: paths.providerRoot,
            });
          } catch (error) {
            console.warn("Could not update cache access metadata", error);
          }
          return {
            outcome: "hit",
            path: artifactPath!,
            source: "versioned",
            entryDirectory,
            materializedRestore,
          };
        }
      } finally {
        releaseEntryLock(lock);
      }
      versionedMissReason = "corrupt";
    } else {
      versionedMissReason = "lock-busy";
    }
  }

  const legacyPath = getLegacyArtifactPath(paths, platform, fingerprintHash);
  if (!legacyPath) {
    return {
      outcome: "miss",
      reason: versionedMissReason ?? "unsafe-legacy-path",
    };
  }
  if (isLegacyArtifactValid(legacyPath, platform)) {
    console.warn(`Using unverified legacy ${platform} cache entry`);
    return {
      outcome: "hit",
      path: legacyPath,
      source: "legacy",
      entryDirectory: null,
      materializedRestore: false,
    };
  }
  if (pathExists(legacyPath)) {
    return {
      outcome: "miss",
      reason: versionedMissReason ?? "legacy-invalid",
    };
  }

  return { outcome: "miss", reason: versionedMissReason ?? "not-found" };
};

export const resolveCacheEntry = async (
  identity: CacheIdentity
): Promise<string | null> => {
  const result = await resolveCacheEntryDetailed(identity);
  return result.outcome === "hit" ? result.path : null;
};

export const uploadCacheEntry = async (
  { projectRoot, platform, fingerprintHash }: CacheIdentity,
  buildPath: string,
  options: {
    insight?: CacheInsight;
    compressionMode?: CompressionMode;
    replaceCompressedUnavailable?: boolean;
    replaceCompressedPayloadDigest?: string;
    codec?: ZstdCodec | null;
  } = {}
): Promise<string | null> => {
  validateSourceArtifact(buildPath, platform);

  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  ensureManagedDirectory(paths.providerRoot, paths.locksRoot);
  const entryId = getEntryId(platform, fingerprintHash);
  const entryDirectory = getEntryDirectory(paths, platform, entryId);
  const lock = await acquireEntryLock(paths.locksRoot, entryId);

  if (!lock) {
    throw new Error(`Timed out waiting to cache the ${platform} build`);
  }

  let stagingDirectory: string | null = null;
  let replacementTombstone: string | null = null;
  let replacementRestoreTombstone: string | null = null;
  try {
    if (pathExists(entryDirectory)) {
      const existing = validateEntry(
        entryDirectory,
        paths.providerRoot,
        platform,
        fingerprintHash,
        entryId
      );
      if (existing.valid) {
        if (
          !options.replaceCompressedUnavailable ||
          existing.manifest.schemaVersion !== 2 ||
          options.replaceCompressedPayloadDigest !==
            existing.manifest.payload.integrity.digest
        ) {
          try {
            touchAccessRecord(paths.accessRoot, entryId, platform, {
              providerRoot: paths.providerRoot,
            });
          } catch (error) {
            console.warn("Could not update cache access metadata", error);
          }
          return existing.artifactPath ?? existing.payloadPath;
        }
      } else {
        quarantineEntry(
          entryDirectory,
          paths.providerRoot,
          paths.quarantineRoot,
          platform,
          entryId,
          existing.reason,
          getRestoreDirectory(paths, platform, entryId)
        );
      }
    }

    ensureManagedDirectory(paths.providerRoot, paths.stagingRoot);
    ensureManagedDirectory(paths.providerRoot, path.dirname(entryDirectory));
    stagingDirectory = fs.mkdtempSync(
      path.join(paths.stagingRoot, `${entryId}-`)
    );

    const artifactName = getArtifactName(platform);
    const logicalDirectory = path.join(stagingDirectory, "logical");
    fs.mkdirSync(logicalDirectory, { mode: 0o700 });
    const stagedArtifact = path.join(logicalDirectory, artifactName);
    copyArtifact(buildPath, stagedArtifact, platform);
    const integrity = inspectArtifact(stagedArtifact, platform);

    const schema1Manifest: CacheManifestV1 = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      platform,
      fingerprintHash,
      entryId,
      createdAt: new Date().toISOString(),
      createdBy: {
        name: "eas-local-cache",
        version: getPackageVersion(),
      },
      artifact: {
        relativePath: artifactName,
        type: platform === "ios" ? "directory" : "file",
        sizeBytes: integrity.sizeBytes,
        fileCount: integrity.fileCount,
        integrity: {
          algorithm: integrity.algorithm,
          digest: integrity.digest,
        },
      },
    };
    if (options.insight) {
      try {
        if (
          options.insight.platform !== platform ||
          options.insight.fingerprintHash !== fingerprintHash ||
          options.insight.entryId !== entryId
        ) {
          throw new Error("Cache insight identity does not match the entry");
        }
        writeInsightAtomically(stagingDirectory, options.insight);
      } catch (error) {
        try {
          fs.rmSync(path.join(stagingDirectory, INSIGHT_FILENAME), {
            force: true,
          });
        } catch {
          // Diagnostic metadata must never block artifact publication.
        }
        console.warn("Could not persist cache insight", error);
      }
    }

    let manifest: CacheManifest = schema1Manifest;
    if (
      (options.compressionMode ?? "off") === "zstd" &&
      !options.replaceCompressedUnavailable
    ) {
      const insightPath = path.join(stagingDirectory, INSIGHT_FILENAME);
      const compression = await prepareCompressedEntry({
        stagingDirectory,
        logicalSnapshot: stagedArtifact,
        platform,
        schema1Manifest,
        insightBytes: pathExists(insightPath)
          ? fs.lstatSync(insightPath).size
          : 0,
        ...(options.codec === undefined ? {} : { codec: options.codec }),
      });
      if (compression.status === "compressed") {
        manifest = compression.manifest;
        fs.rmSync(logicalDirectory, { recursive: true, force: true });
      } else {
        console.warn(
          `Compression unavailable; storing the ${platform} artifact normally (${compression.reason})`
        );
      }
    }
    if (manifest.schemaVersion === 1) {
      fs.renameSync(stagedArtifact, path.join(stagingDirectory, artifactName));
      fs.rmSync(logicalDirectory, { recursive: true, force: true });
      fs.rmSync(
        path.join(stagingDirectory, getCompressedArtifactName(platform)),
        {
          force: true,
        }
      );
    }
    writeManifest(stagingDirectory, manifest);

    const stagedValidation = validateEntry(
      stagingDirectory,
      paths.providerRoot,
      platform,
      fingerprintHash,
      entryId
    );
    if (!stagedValidation.valid) {
      throw new Error(
        `Staged cache validation failed: ${stagedValidation.reason}`
      );
    }

    if (pathExists(entryDirectory)) {
      ensureManagedDirectory(paths.providerRoot, paths.trashRoot);
      replacementTombstone = path.join(
        paths.trashRoot,
        `${platform}-${entryId}-replacement-${crypto.randomUUID()}`
      );
      const restoreDirectory = getRestoreDirectory(paths, platform, entryId);
      if (pathExists(restoreDirectory)) {
        assertManagedDirectory(
          paths.providerRoot,
          path.dirname(restoreDirectory)
        );
        replacementRestoreTombstone = path.join(
          paths.trashRoot,
          `${platform}-${entryId}-restore-replacement-${crypto.randomUUID()}`
        );
        fs.renameSync(restoreDirectory, replacementRestoreTombstone);
      }
      try {
        fs.renameSync(entryDirectory, replacementTombstone);
      } catch (error) {
        if (
          replacementRestoreTombstone &&
          pathExists(replacementRestoreTombstone) &&
          !pathExists(restoreDirectory)
        ) {
          fs.renameSync(replacementRestoreTombstone, restoreDirectory);
          replacementRestoreTombstone = null;
        }
        throw error;
      }
    }
    try {
      fs.renameSync(stagingDirectory, entryDirectory);
    } catch (error) {
      if (
        replacementTombstone &&
        pathExists(replacementTombstone) &&
        !pathExists(entryDirectory)
      ) {
        fs.renameSync(replacementTombstone, entryDirectory);
        replacementTombstone = null;
      }
      const restoreDirectory = getRestoreDirectory(paths, platform, entryId);
      if (
        replacementRestoreTombstone &&
        pathExists(replacementRestoreTombstone) &&
        !pathExists(restoreDirectory)
      ) {
        fs.renameSync(replacementRestoreTombstone, restoreDirectory);
        replacementRestoreTombstone = null;
      }
      throw error;
    }
    stagingDirectory = null;
    if (replacementTombstone) {
      fs.rmSync(replacementTombstone, { recursive: true, force: true });
      replacementTombstone = null;
    }
    if (replacementRestoreTombstone) {
      fs.rmSync(replacementRestoreTombstone, {
        recursive: true,
        force: true,
      });
      replacementRestoreTombstone = null;
    }
    try {
      touchAccessRecord(paths.accessRoot, entryId, platform, {
        providerRoot: paths.providerRoot,
      });
    } catch (error) {
      console.warn("Could not create cache access metadata", error);
    }
    return manifest.schemaVersion === 1
      ? path.join(entryDirectory, artifactName)
      : path.join(entryDirectory, manifest.payload.relativePath);
  } finally {
    if (stagingDirectory) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
    releaseEntryLock(lock);
  }
};
