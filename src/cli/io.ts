import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { formatSizeBytes } from "../cache/options";
import { UsageError } from "./arguments";

export const readBoundedFile = (filePath: string, secret = false): string => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > 64 * 1024) {
      throw new UsageError("Pairing input must be a bounded regular file");
    }
    if (secret && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new UsageError("Pairing file permissions must be 0600");
    }
    return fs.readFileSync(descriptor, "utf8").trim();
  } finally {
    fs.closeSync(descriptor);
  }
};

export const writePrivateExclusiveFile = (
  filePath: string,
  contents: string
): { path: string; device: number; inode: number } => {
  const resolvedPath = path.resolve(filePath);
  const parent = path.dirname(resolvedPath);
  const parentStats = fs.lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new UsageError("Pairing file parent must be a real directory");
  }
  const managedParent = fs.realpathSync(parent);
  const managedPath = path.join(managedParent, path.basename(resolvedPath));
  const temporaryPath = path.join(
    managedParent,
    `.${path.basename(resolvedPath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  const descriptor = fs.openSync(
    temporaryPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporaryPath, managedPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  const published = fs.lstatSync(managedPath);
  if (
    published.isSymbolicLink() ||
    !published.isFile() ||
    published.nlink !== 1
  ) {
    throw new Error("Pairing file was not published safely");
  }
  return {
    path: managedPath,
    device: published.dev,
    inode: published.ino,
  };
};

export const removeOwnedPrivateFile = (owned: {
  path: string;
  device: number;
  inode: number;
}): boolean => {
  try {
    const current = fs.lstatSync(owned.path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== owned.device ||
      current.ino !== owned.inode
    ) {
      return false;
    }
    fs.unlinkSync(owned.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const readStdin = async (hidden: boolean): Promise<string> => {
  if (hidden && !process.stdin.isTTY) {
    throw new UsageError("Interactive pairing requires a TTY or --stdin");
  }
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      if (hidden && process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (hidden) process.stderr.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          reject(new Error("Pairing cancelled"));
          finish();
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else if (value.length < 64 * 1024) value += character;
      }
    };
    if (hidden) {
      process.stderr.write("Paste pairing code: ");
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
  });
};

export const printJson = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(remainingSeconds > 0 || (hours === 0 && minutes === 0)
      ? [`${remainingSeconds}s`]
      : []),
  ].join(" ");
};

export const checkedSum = (values: Iterable<number>, label: string): number => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} contains an invalid byte count`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`${label} exceeds the supported byte range`);
    }
  }
  return total;
};

export const formatSignedSize = (bytes: number): string =>
  bytes < 0 ? `-${formatSizeBytes(Math.abs(bytes))}` : formatSizeBytes(bytes);

export const sha256RegularFile = (
  filePath: string,
  expectedBytes: number,
  deadlineMs?: number
): string => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== expectedBytes) {
      throw new Error("LAN wire package changed before serving");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stats.size) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new Error("LAN wire package hashing exceeded its deadline");
      }
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stats.size - offset),
        offset
      );
      if (count === 0) throw new Error("LAN wire package was truncated");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
};
