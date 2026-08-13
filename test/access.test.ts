import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEFAULT_ACCESS_LEASE_MS,
  readAccessRecord,
  removeAccessRecord,
  touchAccessRecord,
} from "../src/cache/access";

const entryId = "a".repeat(64);
let root: string;
let accessRoot: string;
let providerRoot: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-access-"))
  );
  providerRoot = path.join(root, "provider");
  fs.mkdirSync(providerRoot);
  accessRoot = path.join(providerRoot, "access");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cache access metadata", () => {
  it("atomically creates and reads a deterministic access record", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");
    const record = touchAccessRecord(accessRoot, entryId, "ios", {
      now,
      providerRoot,
    });

    expect(record).toEqual({
      schemaVersion: 1,
      entryId,
      platform: "ios",
      lastAccessedAt: now.toISOString(),
      protectedUntil: new Date(
        now.getTime() + DEFAULT_ACCESS_LEASE_MS
      ).toISOString(),
    });
    expect(readAccessRecord(accessRoot, entryId, providerRoot)).toEqual(record);
    expect(fs.readdirSync(accessRoot)).toEqual([`${entryId}.json`]);
  });

  it("uses an injected lease duration", () => {
    const now = new Date("2026-08-13T01:00:00.000Z");
    const record = touchAccessRecord(accessRoot, entryId, "android", {
      now,
      leaseMs: 2_000,
      providerRoot,
    });

    expect(record.protectedUntil).toBe("2026-08-13T01:00:02.000Z");
  });

  it("keeps timestamps monotonic when an older touch arrives", () => {
    touchAccessRecord(accessRoot, entryId, "ios", {
      now: new Date("2026-08-13T02:00:00.000Z"),
      leaseMs: 60_000,
      providerRoot,
    });

    const record = touchAccessRecord(accessRoot, entryId, "ios", {
      now: new Date("2026-08-13T01:00:00.000Z"),
      leaseMs: 1_000,
      providerRoot,
    });

    expect(record.lastAccessedAt).toBe("2026-08-13T02:00:00.000Z");
    expect(record.protectedUntil).toBe("2026-08-13T02:01:00.000Z");
  });

  it("extends timestamps on a later touch", () => {
    touchAccessRecord(accessRoot, entryId, "android", {
      now: new Date("2026-08-13T02:00:00.000Z"),
      leaseMs: 1_000,
      providerRoot,
    });

    const record = touchAccessRecord(accessRoot, entryId, "android", {
      now: new Date("2026-08-13T03:00:00.000Z"),
      leaseMs: 2_000,
      providerRoot,
    });

    expect(record.lastAccessedAt).toBe("2026-08-13T03:00:00.000Z");
    expect(record.protectedUntil).toBe("2026-08-13T03:00:02.000Z");
  });

  it("returns null for missing metadata and reports removal", () => {
    expect(readAccessRecord(accessRoot, entryId, providerRoot)).toBeNull();
    expect(removeAccessRecord(accessRoot, entryId, providerRoot)).toBe(false);

    touchAccessRecord(accessRoot, entryId, "ios", { providerRoot });
    expect(removeAccessRecord(accessRoot, entryId, providerRoot)).toBe(true);
    expect(readAccessRecord(accessRoot, entryId, providerRoot)).toBeNull();
  });

  it("rejects unsafe entry ids without writing outside the access root", () => {
    fs.mkdirSync(accessRoot, { recursive: true });
    const unsafeIds = ["../outside", "A".repeat(64), "a".repeat(63), ""];

    for (const unsafeId of unsafeIds) {
      expect(() =>
        readAccessRecord(accessRoot, unsafeId, providerRoot)
      ).toThrow();
      expect(() =>
        touchAccessRecord(accessRoot, unsafeId, "ios", { providerRoot })
      ).toThrow();
      expect(() =>
        removeAccessRecord(accessRoot, unsafeId, providerRoot)
      ).toThrow();
    }
    expect(fs.readdirSync(root)).toEqual(["provider"]);
    expect(fs.readdirSync(providerRoot)).toEqual(["access"]);
  });

  it("strictly rejects malformed and mismatched records", () => {
    fs.mkdirSync(accessRoot, { recursive: true });
    const accessPath = path.join(accessRoot, `${entryId}.json`);
    const malformedRecords = [
      "not json",
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({
        schemaVersion: 1,
        entryId: "b".repeat(64),
        platform: "ios",
        lastAccessedAt: "2026-08-13T00:00:00.000Z",
        protectedUntil: "2026-08-13T00:15:00.000Z",
      }),
      JSON.stringify({
        schemaVersion: 1,
        entryId,
        platform: "web",
        lastAccessedAt: "invalid",
        protectedUntil: "2026-08-13T00:15:00.000Z",
      }),
      JSON.stringify({
        schemaVersion: 1,
        entryId,
        platform: "android",
        lastAccessedAt: "2026-08-13T00:15:00.000Z",
        protectedUntil: "2026-08-13T00:00:00.000Z",
      }),
    ];

    for (const value of malformedRecords) {
      fs.writeFileSync(accessPath, value);
      expect(() =>
        readAccessRecord(accessRoot, entryId, providerRoot)
      ).toThrow();
    }
  });

  it("replaces malformed regular metadata on touch", () => {
    fs.mkdirSync(accessRoot, { recursive: true });
    fs.writeFileSync(path.join(accessRoot, `${entryId}.json`), "partial");

    const record = touchAccessRecord(accessRoot, entryId, "ios", {
      now: new Date("2026-08-13T04:00:00.000Z"),
      leaseMs: 0,
      providerRoot,
    });

    expect(readAccessRecord(accessRoot, entryId, providerRoot)).toEqual(record);
  });

  it("never follows or replaces an access-record symlink", () => {
    fs.mkdirSync(accessRoot, { recursive: true });
    const outsidePath = path.join(root, "outside.json");
    const outsideContents = '{"secret":true}\n';
    fs.writeFileSync(outsidePath, outsideContents);
    const accessPath = path.join(accessRoot, `${entryId}.json`);
    fs.symlinkSync(outsidePath, accessPath);

    expect(() => readAccessRecord(accessRoot, entryId, providerRoot)).toThrow();
    expect(() =>
      touchAccessRecord(accessRoot, entryId, "ios", { providerRoot })
    ).toThrow();
    expect(() =>
      removeAccessRecord(accessRoot, entryId, providerRoot)
    ).toThrow();
    expect(fs.lstatSync(accessPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outsidePath, "utf8")).toBe(outsideContents);
  });

  it("rejects a symlink access root", () => {
    const realAccessRoot = path.join(providerRoot, "real-access");
    fs.mkdirSync(realAccessRoot);
    const linkedAccessRoot = path.join(providerRoot, "linked-access");
    fs.symlinkSync(realAccessRoot, linkedAccessRoot);

    expect(() =>
      touchAccessRecord(linkedAccessRoot, entryId, "android", { providerRoot })
    ).toThrow();
    expect(() =>
      readAccessRecord(linkedAccessRoot, entryId, providerRoot)
    ).toThrow();
    expect(() =>
      removeAccessRecord(linkedAccessRoot, entryId, providerRoot)
    ).toThrow();
  });

  it("rejects invalid dates and leases", () => {
    expect(() =>
      touchAccessRecord(accessRoot, entryId, "ios", {
        now: new Date(Number.NaN),
        providerRoot,
      })
    ).toThrow();
    expect(() =>
      touchAccessRecord(accessRoot, entryId, "ios", {
        leaseMs: -1,
        providerRoot,
      })
    ).toThrow();
    expect(() =>
      touchAccessRecord(accessRoot, entryId, "ios", {
        leaseMs: 1.5,
        providerRoot,
      })
    ).toThrow();
  });
});
