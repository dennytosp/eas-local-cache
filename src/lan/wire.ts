import * as crypto from "crypto";
import * as fs from "fs";

import { appTreeArchiveBound } from "../cache/app-tree";
import { MAX_MANIFEST_BYTES, type CacheManifest } from "../cache/manifest";
import { getEntryId, type CachePlatform } from "../cache/paths";

export const WIRE_MAGIC = Buffer.from("ELCWIRE1", "ascii");
export const WIRE_SCHEMA_VERSION = 1;
export const MAX_WIRE_HEADER_BYTES = 16 * 1024;
export const MAX_WIRE_BODY_BYTES = 100 * 1024 ** 3;
export const WIRE_PREFIX_BYTES = WIRE_MAGIC.length + 4;

export type WireBodyKind = "raw-apk-v1" | "elc-app-tree-v1" | "zstd-v1";

export type WireHeader = {
  schemaVersion: 1;
  platform: CachePlatform;
  entryId: string;
  manifest: { sizeBytes: number; sha256: string };
  body: { kind: WireBodyKind; sizeBytes: number; sha256: string };
};

export type InspectedWirePackage = {
  packagePath: string;
  totalBytes: number;
  manifestOffset: number;
  bodyOffset: number;
  header: WireHeader;
  manifest: CacheManifest;
  manifestBytes: Buffer;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENTRY_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const COPY_BUFFER_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isBoundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;

const decodeCanonicalUtf8 = (bytes: Buffer, label: string): string => {
  let value: string;
  try {
    value = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(`${label} is not canonical UTF-8`);
  }
  return value;
};

const parseWireHeader = (bytes: Buffer): WireHeader => {
  const contents = decodeCanonicalUtf8(bytes, "Wire header");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Wire header is not valid JSON");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "platform",
      "entryId",
      "manifest",
      "body",
    ]) ||
    parsed.schemaVersion !== WIRE_SCHEMA_VERSION ||
    (parsed.platform !== "android" && parsed.platform !== "ios") ||
    typeof parsed.entryId !== "string" ||
    !ENTRY_ID_PATTERN.test(parsed.entryId) ||
    !isRecord(parsed.manifest) ||
    !hasExactKeys(parsed.manifest, ["sizeBytes", "sha256"]) ||
    !isBoundedInteger(parsed.manifest.sizeBytes, MAX_MANIFEST_BYTES) ||
    parsed.manifest.sizeBytes === 0 ||
    typeof parsed.manifest.sha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.manifest.sha256) ||
    !isRecord(parsed.body) ||
    !hasExactKeys(parsed.body, ["kind", "sizeBytes", "sha256"]) ||
    (parsed.body.kind !== "raw-apk-v1" &&
      parsed.body.kind !== "elc-app-tree-v1" &&
      parsed.body.kind !== "zstd-v1") ||
    !isBoundedInteger(parsed.body.sizeBytes, MAX_WIRE_BODY_BYTES) ||
    parsed.body.sizeBytes === 0 ||
    typeof parsed.body.sha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.body.sha256)
  ) {
    throw new Error("Wire header has unsupported or malformed fields");
  }

  const header = parsed as WireHeader;
  if (JSON.stringify(header) !== contents) {
    throw new Error("Wire header is not canonical JSON");
  }
  return header;
};

const assertExactManifestShape = (manifest: unknown): CacheManifest => {
  if (!isRecord(manifest)) {
    throw new Error("Wire manifest is not an object");
  }
  const expectedManifestKeys =
    manifest.schemaVersion === 2
      ? [
          "schemaVersion",
          "platform",
          "fingerprintHash",
          "entryId",
          "createdAt",
          "createdBy",
          "artifact",
          "payload",
        ]
      : [
          "schemaVersion",
          "platform",
          "fingerprintHash",
          "entryId",
          "createdAt",
          "createdBy",
          "artifact",
        ];
  if (!hasExactKeys(manifest, expectedManifestKeys)) {
    throw new Error("Wire manifest contains unsupported fields");
  }
  if (
    !isRecord(manifest.createdBy) ||
    !hasExactKeys(manifest.createdBy, ["name", "version"]) ||
    !isRecord(manifest.artifact) ||
    !hasExactKeys(manifest.artifact, [
      "relativePath",
      "type",
      "sizeBytes",
      "fileCount",
      "integrity",
    ]) ||
    !isRecord(manifest.artifact.integrity) ||
    !hasExactKeys(manifest.artifact.integrity, ["algorithm", "digest"])
  ) {
    throw new Error("Wire manifest contains unsupported nested fields");
  }
  if (manifest.schemaVersion === 2) {
    if (
      !isRecord(manifest.payload) ||
      !hasExactKeys(manifest.payload, [
        "encoding",
        "archiveFormat",
        "relativePath",
        "sizeBytes",
        "integrity",
        "compressionLevel",
        "schema1EquivalentBytes",
      ]) ||
      !isRecord(manifest.payload.integrity) ||
      !hasExactKeys(manifest.payload.integrity, ["algorithm", "digest"])
    ) {
      throw new Error("Wire manifest contains unsupported payload fields");
    }
  }
  return manifest as CacheManifest;
};

export const getWireBodyKind = (manifest: CacheManifest): WireBodyKind => {
  if (manifest.schemaVersion === 2) return "zstd-v1";
  return manifest.platform === "android" ? "raw-apk-v1" : "elc-app-tree-v1";
};

const assertManifestAndBodyMapping = (
  header: WireHeader,
  manifest: CacheManifest
): void => {
  if (
    manifest.platform !== header.platform ||
    manifest.entryId !== header.entryId ||
    getEntryId(manifest.platform, manifest.fingerprintHash) !== header.entryId
  ) {
    throw new Error("Wire manifest identity does not match its header");
  }
  if (getWireBodyKind(manifest) !== header.body.kind) {
    throw new Error("Wire body kind does not match its cache manifest");
  }
  if (manifest.schemaVersion === 2) {
    if (
      header.body.sizeBytes !== manifest.payload.sizeBytes ||
      header.body.sha256 !== manifest.payload.integrity.digest
    ) {
      throw new Error("Wire zstd body does not match its cache manifest");
    }
    return;
  }
  if (manifest.platform === "android") {
    if (
      header.body.sizeBytes !== manifest.artifact.sizeBytes ||
      header.body.sha256 !== manifest.artifact.integrity.digest
    ) {
      throw new Error("Wire APK body does not match its cache manifest");
    }
    return;
  }
  const maximumArchiveBytes = appTreeArchiveBound(
    manifest.artifact.sizeBytes,
    manifest.artifact.fileCount
  );
  if (header.body.sizeBytes > maximumArchiveBytes) {
    throw new Error("Wire app-tree body exceeds its manifest bound");
  }
};

const readExactly = (
  descriptor: number,
  offset: number,
  length: number,
  label: string
): Buffer => {
  const output = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(
      descriptor,
      output,
      read,
      length - read,
      offset + read
    );
    if (count === 0) throw new Error(`${label} is truncated`);
    read += count;
  }
  return output;
};

export const hashFileSection = (
  descriptor: number,
  offset: number,
  length: number,
  label: string,
  deadlineMs?: number
): string => {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw new Error(`${label} has an unsafe file range`);
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.min(COPY_BUFFER_BYTES, Math.max(1, length))
  );
  let read = 0;
  while (read < length) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new Error(`${label} hashing exceeded its deadline`);
    }
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, length - read),
      offset + read
    );
    if (count === 0) throw new Error(`${label} is truncated`);
    hash.update(buffer.subarray(0, count));
    read += count;
  }
  return hash.digest("hex");
};

export const inspectWirePackage = (input: {
  packagePath: string;
  expectedPlatform?: CachePlatform;
  expectedEntryId?: string;
  deadlineMs?: number;
}): InspectedWirePackage => {
  if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
    throw new Error("Wire package inspection exceeded its deadline");
  }
  const pathStats = fs.lstatSync(input.packagePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error("Wire package must be a regular file");
  }
  const descriptor = fs.openSync(
    input.packagePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const initialStats = fs.fstatSync(descriptor);
    if (
      !initialStats.isFile() ||
      initialStats.dev !== pathStats.dev ||
      initialStats.ino !== pathStats.ino ||
      initialStats.size !== pathStats.size ||
      initialStats.size < WIRE_PREFIX_BYTES + 2
    ) {
      throw new Error("Wire package changed before inspection");
    }
    const prefix = readExactly(
      descriptor,
      0,
      WIRE_PREFIX_BYTES,
      "Wire package prefix"
    );
    if (!prefix.subarray(0, WIRE_MAGIC.length).equals(WIRE_MAGIC)) {
      throw new Error("Wire package has invalid magic");
    }
    const headerLength = prefix.readUInt32BE(WIRE_MAGIC.length);
    if (headerLength === 0 || headerLength > MAX_WIRE_HEADER_BYTES) {
      throw new Error("Wire header length exceeds its limit");
    }
    const headerBytes = readExactly(
      descriptor,
      WIRE_PREFIX_BYTES,
      headerLength,
      "Wire header"
    );
    const header = parseWireHeader(headerBytes);
    if (
      (input.expectedPlatform !== undefined &&
        input.expectedPlatform !== header.platform) ||
      (input.expectedEntryId !== undefined &&
        input.expectedEntryId !== header.entryId)
    ) {
      throw new Error("Wire package does not match the requested entry");
    }
    const manifestOffset = WIRE_PREFIX_BYTES + headerLength;
    const bodyOffset = manifestOffset + header.manifest.sizeBytes;
    const expectedTotal = bodyOffset + header.body.sizeBytes;
    if (
      !Number.isSafeInteger(expectedTotal) ||
      expectedTotal !== initialStats.size
    ) {
      throw new Error("Wire package is truncated or has trailing bytes");
    }
    const manifestBytes = readExactly(
      descriptor,
      manifestOffset,
      header.manifest.sizeBytes,
      "Wire manifest"
    );
    if (
      crypto.createHash("sha256").update(manifestBytes).digest("hex") !==
      header.manifest.sha256
    ) {
      throw new Error("Wire manifest digest does not match its header");
    }
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(
        decodeCanonicalUtf8(manifestBytes, "Wire manifest")
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Wire manifest is not valid JSON");
      }
      throw error;
    }
    const manifest = assertExactManifestShape(parsedManifest);
    assertManifestAndBodyMapping(header, manifest);
    if (
      hashFileSection(
        descriptor,
        bodyOffset,
        header.body.sizeBytes,
        "Wire body",
        input.deadlineMs
      ) !== header.body.sha256
    ) {
      throw new Error("Wire body digest does not match its header");
    }
    const finalStats = fs.fstatSync(descriptor);
    if (
      finalStats.dev !== initialStats.dev ||
      finalStats.ino !== initialStats.ino ||
      finalStats.size !== initialStats.size
    ) {
      throw new Error("Wire package changed during inspection");
    }
    return {
      packagePath: input.packagePath,
      totalBytes: initialStats.size,
      manifestOffset,
      bodyOffset,
      header,
      manifest,
      manifestBytes,
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

export const serializeWireHeader = (header: WireHeader): Buffer => {
  const bytes = Buffer.from(JSON.stringify(header), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_WIRE_HEADER_BYTES) {
    throw new Error("Wire header length exceeds its limit");
  }
  parseWireHeader(bytes);
  return bytes;
};

export const writeAll = (descriptor: number, bytes: Buffer): void => {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset
    );
    if (count === 0) throw new Error("Unable to make wire write progress");
    offset += count;
  }
};

export const copyFileSection = (input: {
  sourceDescriptor: number;
  destinationDescriptor: number;
  offset: number;
  length: number;
  label: string;
  deadlineMs?: number;
}): void => {
  if (BigInt(input.offset) + BigInt(input.length) > MAX_SAFE_BIGINT) {
    throw new Error(`${input.label} has an unsafe file range`);
  }
  const buffer = Buffer.allocUnsafe(
    Math.min(COPY_BUFFER_BYTES, Math.max(1, input.length))
  );
  let copied = 0;
  while (copied < input.length) {
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      throw new Error(`${input.label} copy exceeded its deadline`);
    }
    const count = fs.readSync(
      input.sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.length, input.length - copied),
      input.offset + copied
    );
    if (count === 0) throw new Error(`${input.label} is truncated`);
    writeAll(input.destinationDescriptor, buffer.subarray(0, count));
    copied += count;
  }
};
