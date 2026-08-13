import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { touchAccessRecord } from "./access";
import { copyArtifact, validateSourceArtifact } from "./copy";
import {
  assertManagedDirectory,
  assertProviderRoot,
  ensureManagedDirectory,
  ensureProviderRoot,
  pathExists,
} from "./filesystem";
import { inspectArtifact } from "./integrity";
import { acquireEntryLock, releaseEntryLock } from "./lock";
import { CACHE_SCHEMA_VERSION, CacheManifest, writeManifest } from "./manifest";
import {
  CachePlatform,
  getArtifactName,
  getCachePaths,
  getEntryDirectory,
  getEntryId,
  getLegacyArtifactPath,
} from "./paths";
import { validateEntry } from "./validation";

type CacheIdentity = {
  projectRoot: string;
  platform: CachePlatform;
  fingerprintHash: string;
};

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
  reason: string
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
  fs.renameSync(entryDirectory, destination);

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

export const resolveCacheEntry = async ({
  projectRoot,
  platform,
  fingerprintHash,
}: CacheIdentity): Promise<string | null> => {
  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  const entryId = getEntryId(platform, fingerprintHash);
  const entryDirectory = getEntryDirectory(paths, platform, entryId);

  if (pathExists(entryDirectory)) {
    assertProviderRoot(managedProjectRoot, paths.providerRoot);
    ensureManagedDirectory(paths.providerRoot, paths.locksRoot);
    const lock = await acquireEntryLock(paths.locksRoot, entryId, {
      maxWaitMs: 250,
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
            revalidation.reason
          );
          console.warn(
            `Ignored corrupt ${platform} cache entry: ${revalidation.reason}`
          );
        } else {
          try {
            touchAccessRecord(paths.accessRoot, entryId, platform, {
              providerRoot: paths.providerRoot,
            });
          } catch (error) {
            console.warn("Could not update cache access metadata", error);
          }
          return revalidation.artifactPath;
        }
      } finally {
        releaseEntryLock(lock);
      }
    }
  }

  const legacyPath = getLegacyArtifactPath(paths, platform, fingerprintHash);
  if (legacyPath && isLegacyArtifactValid(legacyPath, platform)) {
    console.warn(`Using unverified legacy ${platform} cache entry`);
    return legacyPath;
  }

  return null;
};

export const uploadCacheEntry = async (
  { projectRoot, platform, fingerprintHash }: CacheIdentity,
  buildPath: string
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
        try {
          touchAccessRecord(paths.accessRoot, entryId, platform, {
            providerRoot: paths.providerRoot,
          });
        } catch (error) {
          console.warn("Could not update cache access metadata", error);
        }
        return existing.artifactPath;
      }
      quarantineEntry(
        entryDirectory,
        paths.providerRoot,
        paths.quarantineRoot,
        platform,
        entryId,
        existing.reason
      );
    }

    ensureManagedDirectory(paths.providerRoot, paths.stagingRoot);
    ensureManagedDirectory(paths.providerRoot, path.dirname(entryDirectory));
    stagingDirectory = fs.mkdtempSync(
      path.join(paths.stagingRoot, `${entryId}-`)
    );

    const artifactName = getArtifactName(platform);
    const stagedArtifact = path.join(stagingDirectory, artifactName);
    copyArtifact(buildPath, stagedArtifact, platform);
    const integrity = inspectArtifact(stagedArtifact, platform);

    const manifest: CacheManifest = {
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

    fs.renameSync(stagingDirectory, entryDirectory);
    stagingDirectory = null;
    try {
      touchAccessRecord(paths.accessRoot, entryId, platform, {
        providerRoot: paths.providerRoot,
      });
    } catch (error) {
      console.warn("Could not create cache access metadata", error);
    }
    return path.join(entryDirectory, artifactName);
  } finally {
    if (stagingDirectory) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
    releaseEntryLock(lock);
  }
};
