import * as fs from "fs";
import * as path from "path";

import type { ArtifactIntegrity } from "./integrity";
import type { CachePlatform } from "./paths";

export const CACHE_SCHEMA_VERSION = 1;
export const COMPRESSED_CACHE_SCHEMA_VERSION = 2;
export const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SCHEMA_2_ARTIFACT_BYTES = 100 * 1024 ** 3;
const MAX_SCHEMA_1_EQUIVALENT_BYTES =
  MAX_SCHEMA_2_ARTIFACT_BYTES + MAX_MANIFEST_BYTES + 1024 ** 2;

type CacheManifestBase = {
  platform: CachePlatform;
  fingerprintHash: string;
  entryId: string;
  createdAt: string;
  createdBy: {
    name: "eas-local-cache";
    version: string;
  };
  artifact: {
    relativePath: "artifact.apk" | "artifact.app";
    type: "file" | "directory";
    sizeBytes: number;
    fileCount: number;
    integrity: {
      algorithm: ArtifactIntegrity["algorithm"];
      digest: string;
    };
  };
};

export type CacheManifestV1 = CacheManifestBase & {
  schemaVersion: 1;
};

export type CompressedCacheManifest = CacheManifestBase & {
  schemaVersion: 2;
  payload: {
    encoding: "zstd";
    archiveFormat: "raw-v1" | "elc-app-tree-v1";
    relativePath: "artifact.apk.zst" | "artifact.app.zst";
    sizeBytes: number;
    integrity: { algorithm: "sha256"; digest: string };
    compressionLevel: 3;
    schema1EquivalentBytes: number;
  };
};

export type CacheManifest = CacheManifestV1 | CompressedCacheManifest;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const isBaseManifestValid = (parsed: Record<string, unknown>): boolean => {
  const createdBy = parsed.createdBy;
  const artifact = parsed.artifact;
  if (!isRecord(createdBy) || !isRecord(artifact)) return false;
  const integrity = artifact.integrity;
  if (!isRecord(integrity)) return false;

  const platform = parsed.platform;
  const platformArtifactValid =
    (platform === "android" &&
      artifact.relativePath === "artifact.apk" &&
      artifact.type === "file" &&
      integrity.algorithm === "sha256") ||
    (platform === "ios" &&
      artifact.relativePath === "artifact.app" &&
      artifact.type === "directory" &&
      integrity.algorithm === "sha256-tree-v1");

  return (
    platformArtifactValid &&
    typeof parsed.fingerprintHash === "string" &&
    parsed.fingerprintHash.length > 0 &&
    typeof parsed.entryId === "string" &&
    /^[a-f0-9]{64}$/.test(parsed.entryId) &&
    typeof parsed.createdAt === "string" &&
    Number.isFinite(Date.parse(parsed.createdAt)) &&
    createdBy.name === "eas-local-cache" &&
    typeof createdBy.version === "string" &&
    createdBy.version.length > 0 &&
    isSafeNonNegativeInteger(artifact.sizeBytes) &&
    isSafeNonNegativeInteger(artifact.fileCount) &&
    artifact.fileCount >= 1 &&
    isSha256(integrity.digest)
  );
};

const isCompressedPayloadValid = (parsed: Record<string, unknown>): boolean => {
  const payload = parsed.payload;
  const artifact = parsed.artifact;
  if (!isRecord(payload) || !isRecord(artifact)) return false;
  const integrity = payload.integrity;
  if (!isRecord(integrity)) return false;
  const platform = parsed.platform;
  const platformPayloadValid =
    (platform === "android" &&
      payload.archiveFormat === "raw-v1" &&
      payload.relativePath === "artifact.apk.zst") ||
    (platform === "ios" &&
      payload.archiveFormat === "elc-app-tree-v1" &&
      payload.relativePath === "artifact.app.zst");

  return (
    platformPayloadValid &&
    payload.encoding === "zstd" &&
    payload.compressionLevel === 3 &&
    isSafeNonNegativeInteger(payload.sizeBytes) &&
    payload.sizeBytes > 0 &&
    payload.sizeBytes <= MAX_SCHEMA_2_ARTIFACT_BYTES &&
    integrity.algorithm === "sha256" &&
    isSha256(integrity.digest) &&
    isSafeNonNegativeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes <= MAX_SCHEMA_2_ARTIFACT_BYTES &&
    isSafeNonNegativeInteger(payload.schema1EquivalentBytes) &&
    payload.schema1EquivalentBytes > 0 &&
    payload.schema1EquivalentBytes <= MAX_SCHEMA_1_EQUIVALENT_BYTES
  );
};

const readBoundedManifest = (descriptor: number): string => {
  const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
  let bytesRead = 0;

  while (bytesRead < buffer.length) {
    const count = fs.readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      null
    );
    if (count === 0) break;
    bytesRead += count;
  }

  if (bytesRead === 0 || bytesRead > MAX_MANIFEST_BYTES) {
    throw new Error("Cache manifest must be a bounded regular file");
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
};

export const readManifest = (entryDirectory: string): CacheManifest => {
  const manifestPath = path.join(entryDirectory, "manifest.json");
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  let contents: string;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_MANIFEST_BYTES) {
      throw new Error("Cache manifest must be a bounded regular file");
    }
    contents = readBoundedManifest(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const parsed: unknown = JSON.parse(contents);

  if (
    !isRecord(parsed) ||
    (parsed.schemaVersion !== CACHE_SCHEMA_VERSION &&
      parsed.schemaVersion !== COMPRESSED_CACHE_SCHEMA_VERSION)
  ) {
    throw new Error("Unsupported or malformed cache manifest");
  }
  if (!isBaseManifestValid(parsed)) {
    throw new Error("Malformed cache manifest fields");
  }
  if (
    parsed.schemaVersion === COMPRESSED_CACHE_SCHEMA_VERSION &&
    !isCompressedPayloadValid(parsed)
  ) {
    throw new Error("Malformed compressed cache payload metadata");
  }
  if (parsed.schemaVersion === CACHE_SCHEMA_VERSION && "payload" in parsed) {
    throw new Error("Schema 1 cache manifests cannot contain a payload");
  }

  return parsed as CacheManifest;
};

export const writeManifest = (
  entryDirectory: string,
  manifest: CacheManifest
): void => {
  const contents = serializeManifest(manifest);
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) {
    throw new Error("Cache manifest exceeds its size limit");
  }
  fs.writeFileSync(path.join(entryDirectory, "manifest.json"), contents, {
    encoding: "utf8",
    mode: 0o600,
  });
};

export const serializeManifest = (manifest: CacheManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
