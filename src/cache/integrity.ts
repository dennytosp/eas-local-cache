import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type ArtifactIntegrity = {
  algorithm: "sha256" | "sha256-tree-v1";
  digest: string;
  sizeBytes: number;
  fileCount: number;
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

      const stats = fs.lstatSync(path.join(root, relativePath));
      if (stats.isDirectory()) {
        walk(relativePath);
      }
    }
  };

  walk("");
  return entries;
};

const inspectFile = (artifactPath: string): ArtifactIntegrity => {
  const stats = fs.lstatSync(artifactPath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error("Android cache artifacts must be non-empty regular files");
  }

  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(artifactPath));

  return {
    algorithm: "sha256",
    digest: hash.digest("hex"),
    sizeBytes: stats.size,
    fileCount: 1,
  };
};

const inspectDirectory = (artifactPath: string): ArtifactIntegrity => {
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

    hashFrame(hash, "file", relativePath, stats.mode, stats.size);
    hash.update(fs.readFileSync(absolutePath));
    hash.update("\0");
    sizeBytes += stats.size;
    fileCount += 1;
  }

  if (fileCount === 0) {
    throw new Error("iOS cache artifacts must contain at least one file");
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
  platform: "android" | "ios"
): ArtifactIntegrity =>
  platform === "ios"
    ? inspectDirectory(artifactPath)
    : inspectFile(artifactPath);
