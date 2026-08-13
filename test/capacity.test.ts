import { describe, expect, it } from "bun:test";

import {
  checkAvailableSpace,
  getArchiveMetadataAllowance,
  getCompressionCapacity,
  getRestoreReserveBytes,
} from "../src/cache/capacity";

describe("compression capacity", () => {
  it("uses bounded reserves", () => {
    expect(getRestoreReserveBytes(1)).toBe(512 * 1024 ** 2);
    expect(getRestoreReserveBytes(100 * 1024 ** 3)).toBe(5 * 1024 ** 3);
    expect(getArchiveMetadataAllowance("android", 10)).toBe(0);
  });

  it("accounts exactly for every simultaneously live iOS artifact", () => {
    const logicalSizeBytes = 100;
    const snapshotApparentBytes = 120;
    const fileCount = 2;
    const result = getCompressionCapacity({
      platform: "ios",
      logicalSizeBytes,
      snapshotApparentBytes,
      fileCount,
    });
    const metadataAllowance = 8 * 1024 ** 2 + fileCount * 8 * 1024;
    const archiveBound = logicalSizeBytes + metadataAllowance;
    const payloadStagingBound =
      archiveBound + Math.ceil(archiveBound * 0.01) + 1024 ** 2;
    const extractedArtifactBound = snapshotApparentBytes + metadataAllowance;
    const reserve = 512 * 1024 ** 2;

    expect(result).toEqual({
      metadataAllowance,
      archiveBound,
      payloadStagingBound,
      extractedArtifactBound,
      uploadWorkingBytes:
        archiveBound * 2 + payloadStagingBound + extractedArtifactBound,
      restoreWorkingBytes: archiveBound * 2,
      uploadRequiredBytes:
        archiveBound * 2 +
        payloadStagingBound +
        extractedArtifactBound +
        reserve,
      restoreRequiredBytes: archiveBound * 2 + reserve,
    });
  });

  it("does not charge Android for iOS-only archive intermediates", () => {
    const result = getCompressionCapacity({
      platform: "android",
      logicalSizeBytes: 100,
      snapshotApparentBytes: 999,
      fileCount: 1,
    });
    const payloadStagingBound = 100 + 1 + 1024 ** 2;
    expect(result).toEqual({
      metadataAllowance: 0,
      archiveBound: 100,
      payloadStagingBound,
      extractedArtifactBound: 100,
      uploadWorkingBytes: payloadStagingBound + 100,
      restoreWorkingBytes: 100,
      uploadRequiredBytes: payloadStagingBound + 100 + 512 * 1024 ** 2,
      restoreRequiredBytes: 100 + 512 * 1024 ** 2,
    });
    expect(result.uploadRequiredBytes).toBeGreaterThan(
      result.restoreRequiredBytes
    );
  });

  it("reports available, insufficient, and unknown filesystem capacity", () => {
    const fake = (free: number) =>
      (() => ({ bavail: BigInt(free), bsize: 1n })) as never;
    expect(checkAvailableSpace(process.cwd(), 5, fake(10)).status).toBe(
      "available"
    );
    expect(checkAvailableSpace(process.cwd(), 20, fake(10)).status).toBe(
      "insufficient"
    );
    expect(checkAvailableSpace(process.cwd(), 5, undefined).status).not.toBe(
      "insufficient"
    );
    expect(
      checkAvailableSpace(process.cwd(), 5, (() => {
        throw new Error();
      }) as never)
    ).toEqual({ status: "unknown" });
  });
});
