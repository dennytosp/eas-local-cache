import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { MAX_COMPRESSED_BYTES, MAX_LOGICAL_BYTES } from "./zstd";

export type ArtifactIntegrity = {
  algorithm: "sha256" | "sha256-tree-v1";
  digest: string;
  sizeBytes: number;
  fileCount: number;
};

type ExpectedArtifactShape = {
  sizeBytes: number;
  fileCount: number;
};

const MAX_APP_TREE_ENTRIES = 1_000_000;

const HASH_CHUNK_BYTES = 1024 * 1024;

const validateExpectedSize = (
  sizeBytes: number,
  maximumBytes: number,
  label: string
): number => {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > maximumBytes
  ) {
    throw new Error(`${label} exceeds the cache integrity limit`);
  }
  return sizeBytes;
};

const openRegularFile = (
  filePath: string,
  maximumBytes: number,
  label: string,
  expectedSizeBytes?: number
): { descriptor: number; stats: fs.Stats } => {
  const expected =
    expectedSizeBytes === undefined
      ? undefined
      : validateExpectedSize(expectedSizeBytes, maximumBytes, label);
  const pathStats = fs.lstatSync(filePath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (pathStats.size > maximumBytes) {
    throw new Error(`${label} exceeds the cache integrity limit`);
  }
  if (expected !== undefined && pathStats.size !== expected) {
    throw new Error(`${label} size does not match its declaration`);
  }

  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino
    ) {
      throw new Error(`${label} changed before integrity inspection`);
    }
    if (stats.size !== pathStats.size) {
      throw new Error(`${label} changed before integrity inspection`);
    }
    if (stats.size > maximumBytes) {
      throw new Error(`${label} exceeds the cache integrity limit`);
    }
    if (expected !== undefined && stats.size !== expected) {
      throw new Error(`${label} size does not match its declaration`);
    }
    return { descriptor, stats };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
};

const hashOpenedFile = (
  descriptor: number,
  initialStats: fs.Stats,
  hash: crypto.Hash,
  label: string
): void => {
  const buffer = Buffer.allocUnsafe(
    Math.min(HASH_CHUNK_BYTES, Math.max(1, initialStats.size))
  );
  let position = 0;
  while (position < initialStats.size) {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, initialStats.size - position),
      position
    );
    if (bytesRead === 0) {
      throw new Error(`${label} changed during integrity inspection`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  const growthProbe = Buffer.allocUnsafe(1);
  if (fs.readSync(descriptor, growthProbe, 0, 1, initialStats.size) !== 0) {
    throw new Error(`${label} grew during integrity inspection`);
  }
  const finalStats = fs.fstatSync(descriptor);
  if (
    finalStats.dev !== initialStats.dev ||
    finalStats.ino !== initialStats.ino ||
    finalStats.size !== initialStats.size
  ) {
    throw new Error(`${label} changed during integrity inspection`);
  }
};

const hashFrame = (
  hash: crypto.Hash,
  type: string,
  relativePath: string,
  mode: number,
  size: number
) => {
  hash.update(
    JSON.stringify({ type, relativePath, mode: mode & 0o7777, size })
  );
  hash.update("\0");
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

const collectRelativePaths = (root: string): string[] => {
  const entries: string[] = [];

  const walk = (relativeDirectory: string) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    const children = fs
      .readdirSync(absoluteDirectory)
      .sort((left, right) => left.localeCompare(right, "en"));

    for (const child of children) {
      const relativePath = path.posix.join(
        relativeDirectory.split(path.sep).join(path.posix.sep),
        child
      );
      entries.push(relativePath);
      if (entries.length > MAX_APP_TREE_ENTRIES) {
        throw new Error("iOS cache artifact contains too many entries");
      }

      const stats = fs.lstatSync(path.join(root, relativePath));
      if (stats.isDirectory()) {
        walk(relativePath);
      }
    }
  };

  walk("");
  return entries;
};

const inspectFile = (
  artifactPath: string,
  expected?: ExpectedArtifactShape
): ArtifactIntegrity => {
  if (expected && expected.fileCount !== 1) {
    throw new Error("Android cache artifact file count does not match");
  }
  const opened = openRegularFile(
    artifactPath,
    MAX_LOGICAL_BYTES,
    "Android cache artifact",
    expected?.sizeBytes
  );
  if (opened.stats.size === 0) {
    fs.closeSync(opened.descriptor);
    throw new Error("Android cache artifacts must be non-empty regular files");
  }

  const hash = crypto.createHash("sha256");
  try {
    hashOpenedFile(
      opened.descriptor,
      opened.stats,
      hash,
      "Android cache artifact"
    );
  } finally {
    fs.closeSync(opened.descriptor);
  }

  return {
    algorithm: "sha256",
    digest: hash.digest("hex"),
    sizeBytes: opened.stats.size,
    fileCount: 1,
  };
};

const inspectDirectory = (
  artifactPath: string,
  expected?: ExpectedArtifactShape
): ArtifactIntegrity => {
  if (expected) {
    validateExpectedSize(
      expected.sizeBytes,
      MAX_LOGICAL_BYTES,
      "iOS cache artifact"
    );
    if (!Number.isSafeInteger(expected.fileCount) || expected.fileCount <= 0) {
      throw new Error("iOS cache artifact file count is invalid");
    }
  }
  const rootStats = fs.lstatSync(artifactPath);
  if (!rootStats.isDirectory()) {
    throw new Error("iOS cache artifacts must be .app directories");
  }

  const infoPlist = path.join(artifactPath, "Info.plist");
  if (!fs.existsSync(infoPlist) || !fs.lstatSync(infoPlist).isFile()) {
    throw new Error("iOS cache artifacts must contain Info.plist");
  }

  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  let fileCount = 0;

  for (const relativePath of collectRelativePaths(artifactPath)) {
    const absolutePath = path.join(artifactPath, relativePath);
    const stats = fs.lstatSync(absolutePath);

    if (stats.isDirectory()) {
      hashFrame(hash, "directory", relativePath, stats.mode, 0);
      continue;
    }

    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(absolutePath);
      if (
        path.isAbsolute(target) ||
        !isPathInside(
          path.resolve(artifactPath),
          path.resolve(path.dirname(absolutePath), target)
        )
      ) {
        throw new Error(
          `App bundle symlink escapes the artifact root: ${relativePath}`
        );
      }
      const targetSize = Buffer.byteLength(target);
      hashFrame(hash, "symlink", relativePath, stats.mode, targetSize);
      hash.update(target);
      hash.update("\0");
      continue;
    }

    if (!stats.isFile()) {
      throw new Error(`Unsupported app bundle entry: ${relativePath}`);
    }

    if (expected && fileCount >= expected.fileCount) {
      throw new Error("iOS cache artifact file count exceeds its declaration");
    }

    const remainingBytes =
      (expected?.sizeBytes ?? MAX_LOGICAL_BYTES) - sizeBytes;
    const opened = openRegularFile(
      absolutePath,
      Math.min(MAX_LOGICAL_BYTES, Math.max(0, remainingBytes)),
      `App bundle file ${relativePath}`
    );
    hashFrame(hash, "file", relativePath, opened.stats.mode, opened.stats.size);
    try {
      hashOpenedFile(
        opened.descriptor,
        opened.stats,
        hash,
        `App bundle file ${relativePath}`
      );
    } finally {
      fs.closeSync(opened.descriptor);
    }
    hash.update("\0");
    sizeBytes += opened.stats.size;
    fileCount += 1;
    if (expected && fileCount > expected.fileCount) {
      throw new Error("iOS cache artifact file count exceeds its declaration");
    }
  }

  if (fileCount === 0) {
    throw new Error("iOS cache artifacts must contain at least one file");
  }
  if (
    expected &&
    (sizeBytes !== expected.sizeBytes || fileCount !== expected.fileCount)
  ) {
    throw new Error("iOS cache artifact shape does not match its declaration");
  }

  return {
    algorithm: "sha256-tree-v1",
    digest: hash.digest("hex"),
    sizeBytes,
    fileCount,
  };
};

export const inspectArtifact = (
  artifactPath: string,
  platform: "android" | "ios",
  expected?: ExpectedArtifactShape
): ArtifactIntegrity =>
  platform === "ios"
    ? inspectDirectory(artifactPath, expected)
    : inspectFile(artifactPath, expected);

export const inspectPayloadFile = (
  payloadPath: string,
  expectedSizeBytes?: number
): { sizeBytes: number; digest: string } => {
  const opened = openRegularFile(
    payloadPath,
    MAX_COMPRESSED_BYTES,
    "Compressed cache payload",
    expectedSizeBytes
  );
  if (opened.stats.size <= 0) {
    fs.closeSync(opened.descriptor);
    throw new Error(
      "Compressed cache payload must be a non-empty regular file"
    );
  }
  const hash = crypto.createHash("sha256");
  try {
    hashOpenedFile(
      opened.descriptor,
      opened.stats,
      hash,
      "Compressed cache payload"
    );
  } finally {
    fs.closeSync(opened.descriptor);
  }
  return { sizeBytes: opened.stats.size, digest: hash.digest("hex") };
};
