import * as crypto from "crypto";
import * as path from "path";

export type CachePlatform = "android" | "ios";

export type CachePaths = {
  cacheRoot: string;
  providerRoot: string;
  entriesRoot: string;
  stagingRoot: string;
  locksRoot: string;
  quarantineRoot: string;
  accessRoot: string;
  eventsRoot: string;
  stateRoot: string;
  trashRoot: string;
  restoresRoot: string;
  restoreStagingRoot: string;
  transferStagingRoot: string;
  transferLocksRoot: string;
};

export const getCachePaths = (projectRoot: string): CachePaths => {
  const cacheRoot = path.join(projectRoot, ".expo", "cache");
  const providerRoot = path.join(cacheRoot, "eas-local-cache", "v1");

  return {
    cacheRoot,
    providerRoot,
    entriesRoot: path.join(providerRoot, "entries"),
    stagingRoot: path.join(providerRoot, "staging"),
    locksRoot: path.join(providerRoot, "locks"),
    quarantineRoot: path.join(providerRoot, "quarantine"),
    accessRoot: path.join(providerRoot, "access"),
    eventsRoot: path.join(providerRoot, "events"),
    stateRoot: path.join(providerRoot, "state"),
    trashRoot: path.join(providerRoot, "trash"),
    restoresRoot: path.join(providerRoot, "restores"),
    restoreStagingRoot: path.join(providerRoot, "restores", "staging"),
    transferStagingRoot: path.join(providerRoot, "transfer-staging"),
    transferLocksRoot: path.join(providerRoot, "transfer-locks"),
  };
};

export const getEntryId = (
  platform: CachePlatform,
  fingerprintHash: string
): string =>
  crypto
    .createHash("sha256")
    .update(platform)
    .update("\0")
    .update(fingerprintHash)
    .digest("hex");

export const getEntryDirectory = (
  paths: CachePaths,
  platform: CachePlatform,
  entryId: string
): string => path.join(paths.entriesRoot, platform, entryId);

export const getArtifactName = (
  platform: CachePlatform
): "artifact.app" | "artifact.apk" =>
  platform === "ios" ? "artifact.app" : "artifact.apk";

export const getCompressedArtifactName = (
  platform: CachePlatform
): "artifact.app.zst" | "artifact.apk.zst" =>
  platform === "ios" ? "artifact.app.zst" : "artifact.apk.zst";

export const getRestoreDirectory = (
  paths: CachePaths,
  platform: CachePlatform,
  entryId: string
): string => path.join(paths.restoresRoot, platform, entryId);

export const getLegacyArtifactPath = (
  paths: CachePaths,
  platform: CachePlatform,
  fingerprintHash: string
): string | null => {
  const extension = platform === "ios" ? ".app" : ".apk";
  const filename = `${platform}_${fingerprintHash}${extension}`;

  if (path.basename(filename) !== filename) {
    return null;
  }

  const candidate = path.resolve(paths.cacheRoot, filename);
  if (path.dirname(candidate) !== path.resolve(paths.cacheRoot)) {
    return null;
  }

  return candidate;
};
