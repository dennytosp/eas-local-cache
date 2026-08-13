import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-locks-"))
);
const lockId = (marker: string): string =>
  Buffer.from(marker).toString("hex").padEnd(64, "0").slice(0, 64);

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

describe("entry locks", () => {
  it("does not steal a lock held by the current live process", async () => {
    const first = await acquireEntryLock(root, lockId("active"));
    const second = await acquireEntryLock(root, lockId("active"), {
      maxWaitMs: 20,
      retryIntervalMs: 5,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    releaseEntryLock(first!);
  });

  it("recovers a lock owned by a dead same-host process", async () => {
    const entryId = lockId("dead");
    const lockDirectory = path.join(root, `${entryId}.lock`);
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        token: "dead",
        pid: 2_147_483_647,
        hostname: os.hostname(),
        createdAt: new Date(0).toISOString(),
      })}\n`
    );

    const recovered = await acquireEntryLock(root, entryId, { maxWaitMs: 20 });

    expect(recovered).not.toBeNull();
    expect(recovered!.token).not.toBe("dead");
    releaseEntryLock(recovered!);
  });

  it("keeps a young malformed lock instead of guessing that it is stale", async () => {
    const entryId = lockId("young");
    const lockDirectory = path.join(root, `${entryId}.lock`);
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(lockDirectory, "owner.json"), "partial");

    const acquired = await acquireEntryLock(root, entryId, {
      maxWaitMs: 20,
      retryIntervalMs: 5,
      foreignHostStaleMs: 60_000,
    });

    expect(acquired).toBeNull();
    expect(fs.existsSync(lockDirectory)).toBe(true);
  });

  it("does not release a successor lock with a different token", async () => {
    const lock = await acquireEntryLock(root, lockId("successor"));
    expect(lock).not.toBeNull();

    fs.writeFileSync(
      path.join(lock!.directory, "owner.json"),
      `${JSON.stringify({
        token: "successor-token",
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      })}\n`
    );

    releaseEntryLock(lock!);
    expect(fs.existsSync(lock!.directory)).toBe(true);
  });
});
