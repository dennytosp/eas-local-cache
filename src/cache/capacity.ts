import * as fs from "fs";
import * as path from "path";

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

const checkedAdd = (...values: number[]): number => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Cache capacity calculation overflowed");
  }
  return total;
};

export const getRestoreReserveBytes = (logicalSizeBytes: number): number =>
  Math.min(
    5 * GIBIBYTE,
    Math.max(512 * MEBIBYTE, Math.ceil(logicalSizeBytes * 0.05))
  );

export const getArchiveMetadataAllowance = (
  platform: "ios" | "android",
  fileCount: number
): number =>
  platform === "android"
    ? 0
    : Math.min(GIBIBYTE, checkedAdd(8 * MEBIBYTE, fileCount * 8 * 1024));

export const getCompressionCapacity = (input: {
  platform: "ios" | "android";
  logicalSizeBytes: number;
  snapshotApparentBytes: number;
  fileCount: number;
}) => {
  const metadataAllowance = getArchiveMetadataAllowance(
    input.platform,
    input.fileCount
  );
  const archiveBound = checkedAdd(input.logicalSizeBytes, metadataAllowance);
  const payloadStagingBound = checkedAdd(
    archiveBound,
    Math.ceil(archiveBound * 0.01),
    MEBIBYTE
  );
  const reserve = getRestoreReserveBytes(input.logicalSizeBytes);
  const extractedArtifactBound =
    input.platform === "ios"
      ? checkedAdd(input.snapshotApparentBytes, metadataAllowance)
      : input.logicalSizeBytes;
  const uploadWorkingBytes =
    input.platform === "ios"
      ? checkedAdd(
          archiveBound,
          payloadStagingBound,
          archiveBound,
          extractedArtifactBound
        )
      : checkedAdd(payloadStagingBound, extractedArtifactBound);
  const restoreWorkingBytes =
    input.platform === "ios"
      ? checkedAdd(
          archiveBound,
          checkedAdd(input.logicalSizeBytes, metadataAllowance)
        )
      : input.logicalSizeBytes;
  return {
    metadataAllowance,
    archiveBound,
    payloadStagingBound,
    extractedArtifactBound,
    uploadWorkingBytes,
    restoreWorkingBytes,
    uploadRequiredBytes: checkedAdd(uploadWorkingBytes, reserve),
    restoreRequiredBytes: checkedAdd(restoreWorkingBytes, reserve),
  };
};

const nearestExistingAncestor = (candidate: string): string => {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("No existing filesystem ancestor");
    current = parent;
  }
  return current;
};

export type SpaceCheckResult =
  | { status: "available"; freeBytes: number }
  | { status: "insufficient"; freeBytes: number }
  | { status: "unknown" };

export const checkAvailableSpace = (
  candidate: string,
  requiredBytes: number,
  statfs: typeof fs.statfsSync | undefined = fs.statfsSync
): SpaceCheckResult => {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
    throw new Error("Required cache capacity must be a positive safe integer");
  }
  if (typeof statfs !== "function") return { status: "unknown" };
  try {
    const stats = statfs(nearestExistingAncestor(candidate));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
      return { status: "unknown" };
    }
    return freeBytes >= requiredBytes
      ? { status: "available", freeBytes }
      : { status: "insufficient", freeBytes };
  } catch {
    return { status: "unknown" };
  }
};
