import * as fs from "fs";
import * as path from "path";

import { extractAppTree, encodeAppTree } from "./app-tree";
import { checkAvailableSpace, getCompressionCapacity } from "./capacity";
import { calculatePathSize } from "./filesystem";
import { inspectArtifact, inspectPayloadFile } from "./integrity";
import {
  COMPRESSED_CACHE_SCHEMA_VERSION,
  serializeManifest,
  type CacheManifestV1,
  type CompressedCacheManifest,
} from "./manifest";
import { getCompressedArtifactName, type CachePlatform } from "./paths";
import { discoverZstdCodec, type ZstdCodec } from "./zstd";

export type CompressionPreparationResult =
  | { status: "compressed"; manifest: CompressedCacheManifest }
  | { status: "fallback"; reason: string };

const sameIntegrity = (
  left: ReturnType<typeof inspectArtifact>,
  right: ReturnType<typeof inspectArtifact>
): boolean =>
  left.algorithm === right.algorithm &&
  left.digest === right.digest &&
  left.sizeBytes === right.sizeBytes &&
  left.fileCount === right.fileCount;

export const prepareCompressedEntry = async (input: {
  stagingDirectory: string;
  logicalSnapshot: string;
  platform: CachePlatform;
  schema1Manifest: CacheManifestV1;
  insightBytes: number;
  codec?: ZstdCodec | null;
}): Promise<CompressionPreparationResult> => {
  const codec = input.codec === undefined ? discoverZstdCodec() : input.codec;
  if (!codec) return { status: "fallback", reason: "zstd unavailable" };

  const before = inspectArtifact(input.logicalSnapshot, input.platform);
  const snapshotApparentBytes = calculatePathSize(input.logicalSnapshot);
  const capacity = getCompressionCapacity({
    platform: input.platform,
    logicalSizeBytes: before.sizeBytes,
    snapshotApparentBytes,
    fileCount: before.fileCount,
  });
  if (
    checkAvailableSpace(input.stagingDirectory, capacity.uploadRequiredBytes)
      .status === "insufficient"
  ) {
    return { status: "fallback", reason: "insufficient compression space" };
  }

  const inputStream = path.join(input.stagingDirectory, "logical.stream");
  const payloadName = getCompressedArtifactName(input.platform);
  const payloadPath = path.join(input.stagingDirectory, payloadName);
  const decodedStream = path.join(input.stagingDirectory, "decoded.stream");
  const decodedArtifact = path.join(
    input.stagingDirectory,
    input.platform === "ios" ? "decoded.app" : "decoded.apk"
  );
  try {
    let archiveBytes = before.sizeBytes;
    if (input.platform === "ios") {
      const encoded = await encodeAppTree(input.logicalSnapshot, inputStream);
      archiveBytes = encoded.archiveBytes;
    }
    const afterSnapshot = inspectArtifact(
      input.logicalSnapshot,
      input.platform
    );
    if (
      !sameIntegrity(before, afterSnapshot) ||
      calculatePathSize(input.logicalSnapshot) !== snapshotApparentBytes
    ) {
      return {
        status: "fallback",
        reason: "build artifact changed during copy",
      };
    }
    const codecInput =
      input.platform === "ios" ? inputStream : input.logicalSnapshot;
    await codec.encode(codecInput, payloadPath, {
      maxOutputBytes: capacity.payloadStagingBound,
      logicalSizeBytes: Math.max(1, archiveBytes),
    });
    const payload = inspectPayloadFile(payloadPath);
    await codec.decode(payloadPath, decodedStream, {
      maxOutputBytes: capacity.archiveBound,
      logicalSizeBytes: Math.max(1, before.sizeBytes),
    });
    if (input.platform === "ios") {
      await extractAppTree(decodedStream, decodedArtifact, {
        sizeBytes: before.sizeBytes,
        fileCount: before.fileCount,
        maxArchiveBytes: capacity.archiveBound,
      });
    } else {
      fs.renameSync(decodedStream, decodedArtifact);
    }
    const decoded = inspectArtifact(decodedArtifact, input.platform);
    if (!sameIntegrity(before, decoded)) {
      return {
        status: "fallback",
        reason: "compressed round trip changed artifact",
      };
    }

    const schema1EquivalentBytes =
      snapshotApparentBytes +
      Buffer.byteLength(serializeManifest(input.schema1Manifest)) +
      input.insightBytes;
    const manifest: CompressedCacheManifest = {
      ...input.schema1Manifest,
      schemaVersion: COMPRESSED_CACHE_SCHEMA_VERSION,
      payload: {
        encoding: "zstd",
        archiveFormat: input.platform === "ios" ? "elc-app-tree-v1" : "raw-v1",
        relativePath: payloadName,
        sizeBytes: payload.sizeBytes,
        integrity: { algorithm: "sha256", digest: payload.digest },
        compressionLevel: 3,
        schema1EquivalentBytes,
      },
    };
    const compressedBytes =
      payload.sizeBytes +
      Buffer.byteLength(serializeManifest(manifest)) +
      input.insightBytes;
    if (compressedBytes >= schema1EquivalentBytes) {
      return { status: "fallback", reason: "compressed entry is not smaller" };
    }
    return { status: "compressed", manifest };
  } catch (error) {
    return {
      status: "fallback",
      reason: error instanceof Error ? error.message : "zstd operation failed",
    };
  } finally {
    for (const disposable of [inputStream, decodedStream, decodedArtifact]) {
      fs.rmSync(disposable, { recursive: true, force: true });
    }
  }
};
