import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type EntryLock = {
  directory: string;
  token: string;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

type AcquireLockOptions = {
  maxWaitMs?: number;
  retryIntervalMs?: number;
  foreignHostStaleMs?: number;
};

const delay = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const readOwner = (lockDirectory: string): LockOwner | null => {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8")
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "token" in value &&
      typeof value.token === "string" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      "hostname" in value &&
      typeof value.hostname === "string" &&
      "createdAt" in value &&
      typeof value.createdAt === "string"
    ) {
      return value as LockOwner;
    }
  } catch {
    // A missing or partially written owner is handled conservatively below.
  }
  return null;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isStale = (
  lockDirectory: string,
  foreignHostStaleMs: number
): boolean => {
  const owner = readOwner(lockDirectory);
  const stats = fs.statSync(lockDirectory);
  const ageMs = Date.now() - stats.mtimeMs;

  if (!owner) {
    return ageMs > foreignHostStaleMs;
  }

  if (owner.hostname === os.hostname()) {
    return !isProcessAlive(owner.pid);
  }

  return ageMs > foreignHostStaleMs;
};

const breakStaleLock = (lockDirectory: string): boolean => {
  const tombstone = `${lockDirectory}.stale-${
    process.pid
  }-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockDirectory, tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") {
      return false;
    }
    throw error;
  }
};

export const acquireEntryLock = async (
  locksRoot: string,
  entryId: string,
  options: AcquireLockOptions = {}
): Promise<EntryLock | null> => {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const foreignHostStaleMs = options.foreignHostStaleMs ?? 10 * 60_000;
  const deadline = Date.now() + maxWaitMs;
  const lockDirectory = path.join(locksRoot, `${entryId}.lock`);

  fs.mkdirSync(locksRoot, { recursive: true });

  while (true) {
    const token = crypto.randomUUID();
    try {
      fs.mkdirSync(lockDirectory);
      const owner: LockOwner = {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(
          path.join(lockDirectory, "owner.json"),
          `${JSON.stringify(owner)}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
      } catch (error) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return { directory: lockDirectory, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    try {
      if (isStale(lockDirectory, foreignHostStaleMs)) {
        breakStaleLock(lockDirectory);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (Date.now() >= deadline) {
      return null;
    }

    const jitter = Math.floor(Math.random() * Math.max(1, retryIntervalMs / 4));
    await delay(retryIntervalMs + jitter);
  }
};

export const releaseEntryLock = (lock: EntryLock) => {
  const owner = readOwner(lock.directory);
  if (owner?.token !== lock.token) {
    return;
  }

  fs.rmSync(lock.directory, { recursive: true, force: true });
};
