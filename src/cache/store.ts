import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { copyArtifact, validateSourceArtifact } from "./copy";
import { inspectArtifact } from "./integrity";
import { acquireEntryLock, releaseEntryLock } from "./lock";
import {
  CACHE_SCHEMA_VERSION,
  CacheManifest,
  readManifest,
  writeManifest,
} from "./manifest";
import {
  CachePlatform,
  getArtifactName,
  getCachePaths,
  getEntryDirectory,
  getEntryId,
  getLegacyArtifactPath,
} from "./paths";

type CacheIdentity = {
  projectRoot: string;
  platform: CachePlatform;
  fingerprintHash: string;
};

type ValidationResult =
  | { valid: true; artifactPath: string; manifest: CacheManifest }
  | { valid: false; reason: string };

const pathExists = (candidate: string): boolean => {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const assertManagedDirectory = (
  providerRoot: string,
  candidate: string
): void => {
  const providerStats = fs.lstatSync(providerRoot);
  const candidateStats = fs.lstatSync(candidate);
  if (
    providerStats.isSymbolicLink() ||
    !providerStats.isDirectory() ||
    candidateStats.isSymbolicLink() ||
    !candidateStats.isDirectory()
  ) {
    throw new Error("Cache-managed paths must be real directories");
  }

  const realProviderRoot = fs.realpathSync(providerRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isPathInside(realProviderRoot, realCandidate)) {
    throw new Error("Cache-managed path escapes the provider root");
  }
};

const ensureRealDirectoryTree = (root: string, candidate: string): void => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Cache-managed roots must be real directories");
  }

  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error("Cache-managed path escapes its trusted root");
  }

  const realRoot = fs.realpathSync(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Cache-managed paths must be real directories");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Cache-managed paths must be real directories");
      }
    }

    if (!isPathInside(realRoot, fs.realpathSync(current))) {
      throw new Error("Cache-managed path escapes its trusted root");
    }
  }
};

const ensureManagedDirectory = (providerRoot: string, candidate: string) =>
  ensureRealDirectoryTree(providerRoot, candidate);

const assertProviderRoot = (
  projectRoot: string,
  providerRoot: string
): void => {
  const projectStats = fs.lstatSync(projectRoot);
  const providerStats = fs.lstatSync(providerRoot);
  if (
    !projectStats.isDirectory() ||
    providerStats.isSymbolicLink() ||
    !providerStats.isDirectory()
  ) {
    throw new Error("The cache provider root must be a real directory");
  }

  if (
    !isPathInside(fs.realpathSync(projectRoot), fs.realpathSync(providerRoot))
  ) {
    throw new Error("The cache provider root escapes the project");
  }
};

const ensureProviderRoot = (
  projectRoot: string,
  providerRoot: string
): void => {
  ensureRealDirectoryTree(projectRoot, providerRoot);
  assertProviderRoot(projectRoot, providerRoot);
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

const validateEntry = (
  entryDirectory: string,
  providerRoot: string,
  platform: CachePlatform,
  fingerprintHash: string,
  entryId: string
): ValidationResult => {
  try {
    assertManagedDirectory(providerRoot, entryDirectory);
    const manifest = readManifest(entryDirectory);
    const expectedArtifactName = getArtifactName(platform);
    const expectedType = platform === "ios" ? "directory" : "file";

    if (
      manifest.platform !== platform ||
      manifest.fingerprintHash !== fingerprintHash ||
      manifest.entryId !== entryId ||
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
    const validation = validateEntry(
      entryDirectory,
      paths.providerRoot,
      platform,
      fingerprintHash,
      entryId
    );
    if (validation.valid) {
      return validation.artifactPath;
    }

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
    return path.join(entryDirectory, artifactName);
  } finally {
    if (stagingDirectory) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
    releaseEntryLock(lock);
  }
};
