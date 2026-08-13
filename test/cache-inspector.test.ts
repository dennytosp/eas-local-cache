import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { removeAccessRecord, touchAccessRecord } from "../src/cache/access";
import { inventoryCache } from "../src/cache/catalog";
import { planPrune, pruneCache } from "../src/cache/cleanup";
import { doctorCache } from "../src/cache/doctor";
import { recordResolveEvent, scanResolveEvents } from "../src/cache/events";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import type { NormalizedCachePolicy } from "../src/cache/options";
import { getCachePaths, getEntryId } from "../src/cache/paths";
import { readManifest } from "../src/cache/manifest";
import { uploadCacheEntry } from "../src/cache/store";
import { runCli } from "../src/cli";

const unlimitedPolicy: NormalizedCachePolicy = {
  maxSizeBytes: null,
  maxEntries: null,
  retentionMs: null,
  autoPrune: true,
};

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-inspector-"))
  );
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const seedEntry = async (
  fingerprint: string,
  contents: string,
  lastAccessedAt: string
) => {
  const source = path.join(projectRoot, `${fingerprint}.apk`);
  fs.writeFileSync(source, contents);
  const artifact = await uploadCacheEntry(
    { projectRoot, platform: "android", fingerprintHash: fingerprint },
    source
  );
  const paths = getCachePaths(projectRoot);
  const entryId = getEntryId("android", fingerprint);
  removeAccessRecord(paths.accessRoot, entryId, paths.providerRoot);
  touchAccessRecord(paths.accessRoot, entryId, "android", {
    now: new Date(lastAccessedAt),
    leaseMs: 0,
    providerRoot: paths.providerRoot,
  });
  return { artifact: artifact!, entryId, paths };
};

describe("cache catalog and cleanup", () => {
  it("keeps an empty inventory read-only", () => {
    const catalog = inventoryCache(projectRoot);

    expect(catalog.entries).toEqual([]);
    expect(catalog.usage.totalBytes).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, ".expo"))).toBe(false);
  });

  it("inventories entries deterministically with exact logical bytes", async () => {
    await seedEntry("second", "22", "2026-08-12T00:00:00.000Z");
    await seedEntry("first", "1", "2026-08-11T00:00:00.000Z");

    const catalog = inventoryCache(projectRoot);

    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.map((entry) => entry.entryId)).toEqual(
      catalog.entries.map((entry) => entry.entryId).sort()
    );
    expect(catalog.entries.map((entry) => entry.lastAccessedAt)).toContain(
      "2026-08-11T00:00:00.000Z"
    );
    expect(catalog.usage.entriesBytes).toBeGreaterThan(3);
    expect(catalog.issues).toEqual([]);
    expect(catalog.usage.managedBytes).toBe(catalog.usage.entriesBytes);
    expect(catalog.usage.totalBytes).toBeGreaterThan(
      catalog.usage.managedBytes
    );
  });

  it("accounts for and prunes invalid entry storage before valid LRU data", async () => {
    const valid = await seedEntry(
      "valid-capacity",
      "valid",
      "2026-08-12T00:00:00.000Z"
    );
    const invalidDirectory = path.join(
      valid.paths.entriesRoot,
      "android",
      "f".repeat(64)
    );
    fs.mkdirSync(invalidDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(invalidDirectory, "partial.apk"),
      "x".repeat(512)
    );

    const before = inventoryCache(projectRoot);
    const validEntry = before.entries.find(
      (entry) => entry.entryId === valid.entryId
    )!;
    expect(before.invalidEntries).toHaveLength(1);
    expect(before.usage.invalidEntriesBytes).toBeGreaterThanOrEqual(512);
    expect(before.usage.managedBytes).toBe(
      before.usage.entriesBytes + before.usage.invalidEntriesBytes
    );

    const result = await pruneCache(
      projectRoot,
      { ...unlimitedPolicy, maxSizeBytes: validEntry.sizeBytes },
      { now: new Date("2026-08-13T00:00:00.000Z") }
    );

    expect(result.auxiliaryRemoved).toContainEqual(
      expect.objectContaining({
        path: invalidDirectory,
        category: "invalid-entry",
      })
    );
    expect(result.removed).toEqual([]);
    expect(result.limitsSatisfied).toBe(true);
    expect(fs.existsSync(invalidDirectory)).toBe(false);
    expect(fs.existsSync(valid.artifact)).toBe(true);
  });

  it("accounts for and removes unexpected platform storage", async () => {
    const valid = await seedEntry(
      "valid-platform",
      "valid",
      "2026-08-12T00:00:00.000Z"
    );
    const unexpected = path.join(valid.paths.entriesRoot, "windows", "entry");
    fs.mkdirSync(unexpected, { recursive: true });
    fs.writeFileSync(path.join(unexpected, "artifact.exe"), "x".repeat(512));

    const before = inventoryCache(projectRoot);
    const validEntry = before.entries.find(
      (entry) => entry.entryId === valid.entryId
    )!;
    expect(before.invalidEntries).toContainEqual(
      expect.objectContaining({
        platform: null,
        directory: path.dirname(unexpected),
      })
    );
    expect(before.issues).toContainEqual(
      expect.objectContaining({ code: "unexpected-entry-layout" })
    );

    const result = await pruneCache(
      projectRoot,
      { ...unlimitedPolicy, maxSizeBytes: validEntry.sizeBytes },
      { now: new Date("2026-08-13T00:00:00.000Z") }
    );

    expect(result.auxiliaryRemoved).toContainEqual(
      expect.objectContaining({
        path: path.dirname(unexpected),
        category: "invalid-entry",
      })
    );
    expect(result.removed).toEqual([]);
    expect(result.limitsSatisfied).toBe(true);
    expect(fs.existsSync(path.dirname(unexpected))).toBe(false);
    expect(fs.existsSync(valid.artifact)).toBe(true);
  });

  it("preserves a leased entry that became invalid after resolution", async () => {
    const leased = await seedEntry(
      "leased-invalid",
      "leased",
      "2026-08-13T00:00:00.000Z"
    );
    removeAccessRecord(
      leased.paths.accessRoot,
      leased.entryId,
      leased.paths.providerRoot
    );
    touchAccessRecord(leased.paths.accessRoot, leased.entryId, "android", {
      now: new Date("2026-08-13T00:00:00.000Z"),
      leaseMs: 60 * 60 * 1000,
      providerRoot: leased.paths.providerRoot,
    });
    fs.writeFileSync(
      path.join(path.dirname(leased.artifact), "manifest.json"),
      "not-json"
    );

    const result = await pruneCache(
      projectRoot,
      { ...unlimitedPolicy, maxSizeBytes: 0, retentionMs: 0 },
      { now: new Date("2026-08-13T00:30:00.000Z") }
    );

    expect(result.auxiliaryRemoved).toEqual([]);
    expect(result.limitsSatisfied).toBe(false);
    expect(fs.existsSync(leased.artifact)).toBe(true);
  });

  it("plans TTL first, then deterministic LRU for count limits", async () => {
    const old = await seedEntry("old", "old", "2026-08-01T00:00:00.000Z");
    const middle = await seedEntry(
      "middle",
      "middle",
      "2026-08-10T00:00:00.000Z"
    );
    const fresh = await seedEntry("fresh", "fresh", "2026-08-12T00:00:00.000Z");
    const catalog = inventoryCache(projectRoot);

    const plan = planPrune(
      catalog.entries,
      {
        ...unlimitedPolicy,
        maxEntries: 1,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
      },
      {
        now: new Date("2026-08-13T00:00:00.000Z"),
        protectedEntryIds: [fresh.entryId],
      }
    );

    expect(plan).toEqual([
      expect.objectContaining({ entryId: old.entryId, reason: "expired" }),
      expect.objectContaining({
        entryId: middle.entryId,
        reason: "max-entries",
      }),
    ]);
  });

  it("uses the same plan for dry-run and real pruning", async () => {
    const oldest = await seedEntry("oldest", "one", "2026-08-01T00:00:00.000Z");
    const newest = await seedEntry("newest", "two", "2026-08-12T00:00:00.000Z");
    const policy = { ...unlimitedPolicy, maxEntries: 1 };

    const dryRun = await pruneCache(projectRoot, policy, {
      dryRun: true,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(dryRun.candidates.map((entry) => entry.entryId)).toEqual([
      oldest.entryId,
    ]);
    expect(fs.existsSync(oldest.artifact)).toBe(true);

    const result = await pruneCache(projectRoot, policy, {
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(result.removed.map((entry) => entry.entryId)).toEqual([
      oldest.entryId,
    ]);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.limitsSatisfied).toBe(true);
    expect(fs.existsSync(oldest.artifact)).toBe(false);
    expect(fs.existsSync(newest.artifact)).toBe(true);
    expect(inventoryCache(projectRoot).entries).toHaveLength(1);
  });

  it("prunes telemetry separately from artifact capacity", async () => {
    const entry = await seedEntry(
      "telemetry-entry",
      "artifact",
      "2026-08-12T00:00:00.000Z"
    );
    const recorded = await recordResolveEvent(
      entry.paths.providerRoot,
      entry.paths.eventsRoot,
      {
        platform: "android",
        entryId: entry.entryId,
        outcome: "miss",
        lookupDurationMs: 12,
        explanationCode: "no-entry",
      },
      { nowMs: Date.parse("2026-01-01T00:00:00.000Z") }
    );
    expect(recorded.status).toBe("recorded");

    const dryRun = await pruneCache(projectRoot, unlimitedPolicy, {
      dryRun: true,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(dryRun.telemetryCandidates).toHaveLength(1);
    expect(dryRun.reclaimedBytes).toBe(0);
    expect(dryRun.telemetryReclaimedBytes).toBe(0);
    expect(fs.existsSync(entry.artifact)).toBe(true);

    const result = await pruneCache(projectRoot, unlimitedPolicy, {
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(result.telemetryRemoved).toHaveLength(1);
    expect(result.telemetryReclaimedBytes).toBeGreaterThan(0);
    expect(result.reclaimedBytes).toBe(0);
    expect(scanResolveEvents(entry.paths.eventsRoot).events).toEqual([]);
    expect(fs.existsSync(entry.artifact)).toBe(true);
  });

  it("does not evict an entry with an active lock", async () => {
    const seeded = await seedEntry(
      "locked",
      "locked",
      "2026-08-01T00:00:00.000Z"
    );
    const lock = await acquireEntryLock(seeded.paths.locksRoot, seeded.entryId);

    try {
      const result = await pruneCache(
        projectRoot,
        { ...unlimitedPolicy, maxEntries: 0 },
        { now: new Date("2026-08-13T00:00:00.000Z") }
      );
      expect(result.removed).toEqual([]);
      expect(result.skipped).toEqual([
        expect.objectContaining({
          entryId: seeded.entryId,
          reason: "entry has an active lock",
        }),
      ]);
      expect(result.limitsSatisfied).toBe(false);
      expect(fs.existsSync(seeded.artifact)).toBe(true);
    } finally {
      releaseEntryLock(lock!);
    }
  });

  it("uses LRU to satisfy an exact size limit", async () => {
    const oldest = await seedEntry(
      "large-old",
      "x".repeat(128),
      "2026-08-01T00:00:00.000Z"
    );
    await seedEntry("small-new", "y", "2026-08-12T00:00:00.000Z");
    const catalog = inventoryCache(projectRoot);
    const newest = catalog.entries.find(
      (entry) => entry.entryId !== oldest.entryId
    )!;

    const result = await pruneCache(
      projectRoot,
      { ...unlimitedPolicy, maxSizeBytes: newest.sizeBytes },
      { now: new Date("2026-08-13T00:00:00.000Z") }
    );

    expect(result.removed.map((entry) => entry.entryId)).toEqual([
      oldest.entryId,
    ]);
    expect(result.remainingBytes).toBeLessThanOrEqual(newest.sizeBytes);
  });

  it("removes expired quarantine data and abandoned trash", async () => {
    const seeded = await seedEntry(
      "auxiliary",
      "entry",
      "2026-08-12T00:00:00.000Z"
    );
    const quarantine = path.join(seeded.paths.quarantineRoot, "old-data");
    const trash = path.join(seeded.paths.trashRoot, "abandoned-data");
    fs.mkdirSync(quarantine, { recursive: true });
    fs.mkdirSync(trash, { recursive: true });
    fs.writeFileSync(path.join(quarantine, "artifact"), "quarantine");
    fs.writeFileSync(path.join(trash, "artifact"), "trash");
    const old = new Date("2026-08-01T00:00:00.000Z");
    fs.utimesSync(quarantine, old, old);

    const result = await pruneCache(
      projectRoot,
      {
        ...unlimitedPolicy,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
      },
      {
        now: new Date("2026-08-13T00:00:00.000Z"),
        protectedEntryIds: [seeded.entryId],
      }
    );

    expect(result.auxiliaryRemoved).toHaveLength(2);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(trash)).toBe(false);
    expect(fs.existsSync(seeded.artifact)).toBe(true);
  });

  it("does not remove staging data owned by an active writer", async () => {
    const seeded = await seedEntry(
      "active-staging",
      "entry",
      "2026-08-12T00:00:00.000Z"
    );
    const staging = path.join(
      seeded.paths.stagingRoot,
      `${seeded.entryId}-partial`
    );
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "partial"), "partial");
    const old = new Date("2026-08-01T00:00:00.000Z");
    fs.utimesSync(staging, old, old);
    const lock = await acquireEntryLock(seeded.paths.locksRoot, seeded.entryId);

    try {
      const result = await pruneCache(
        projectRoot,
        { ...unlimitedPolicy, retentionMs: 0 },
        {
          now: new Date("2026-08-13T00:00:00.000Z"),
          protectedEntryIds: [seeded.entryId],
        }
      );

      expect(result.auxiliaryRemoved).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          entryId: seeded.entryId,
          reason: "staging data has an active writer",
        })
      );
      expect(fs.existsSync(staging)).toBe(true);
    } finally {
      releaseEntryLock(lock!);
    }
  });
});

describe("doctor and CLI", () => {
  it("reports integrity damage without mutating the entry", async () => {
    const entry = await seedEntry(
      "doctor",
      "healthy",
      "2026-08-12T00:00:00.000Z"
    );
    fs.appendFileSync(entry.artifact, "damaged");

    const report = doctorCache(projectRoot);

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "integrity-mismatch" })
    );
    expect(fs.existsSync(entry.artifact)).toBe(true);
  });

  it("uses the resolver identity rules when checking manifests", async () => {
    const entry = await seedEntry(
      "doctor-identity",
      "healthy",
      "2026-08-12T00:00:00.000Z"
    );
    const directory = path.dirname(entry.artifact);
    const manifest = readManifest(directory);
    fs.writeFileSync(
      path.join(directory, "manifest.json"),
      `${JSON.stringify({ ...manifest, fingerprintHash: "wrong" }, null, 2)}\n`
    );

    const report = doctorCache(projectRoot);

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "integrity-mismatch",
        message: "manifest identity mismatch",
      })
    );
  });

  it("reports malformed optional insight without invalidating the artifact", async () => {
    const entry = await seedEntry(
      "doctor-insight",
      "healthy",
      "2026-08-12T00:00:00.000Z"
    );
    fs.writeFileSync(
      path.join(path.dirname(entry.artifact), "insight.json"),
      "{"
    );

    const report = doctorCache(projectRoot);

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-cache-insight" })
    );
    expect(fs.existsSync(entry.artifact)).toBe(true);
  });

  it("emits machine-readable stats and list output", async () => {
    await seedEntry("cli", "cli", "2026-08-12T00:00:00.000Z");

    for (const command of ["stats", "list"]) {
      let output = "";
      const write = spyOn(process.stdout, "write").mockImplementation(((
        chunk: string | Uint8Array
      ) => {
        output += chunk.toString();
        return true;
      }) as typeof process.stdout.write);
      const status = await runCli([
        command,
        "--project-root",
        projectRoot,
        "--json",
      ]);
      write.mockRestore();

      expect(status).toBe(0);
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (command === "stats") {
        expect(parsed.entryCount).toBe(1);
        expect(parsed.hitRate).toBeNull();
        expect(parsed.estimatedTimeSavedMs).toBeNull();
      } else {
        expect(parsed.entries).toBeArrayOfSize(1);
        expect(parsed.legacyEntries).toEqual([]);
      }
    }
  });

  it("reports retained hit rate and conservative time saved", async () => {
    const entry = await seedEntry(
      "stats-events",
      "cli",
      "2026-08-12T00:00:00.000Z"
    );
    for (const event of [
      {
        outcome: "miss" as const,
        lookupDurationMs: 20,
        explanationCode: "no-entry" as const,
      },
      {
        outcome: "hit" as const,
        lookupDurationMs: 5,
        explanationCode: "hit" as const,
        estimatedTimeSavedMs: 1_000,
      },
    ]) {
      expect(
        (
          await recordResolveEvent(
            entry.paths.providerRoot,
            entry.paths.eventsRoot,
            { platform: "android", entryId: entry.entryId, ...event }
          )
        ).status
      ).toBe("recorded");
    }

    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    const status = await runCli([
      "stats",
      "--project-root",
      projectRoot,
      "--json",
    ]);
    write.mockRestore();

    expect(status).toBe(0);
    const parsed = JSON.parse(output) as {
      hitRate: number;
      estimatedTimeSavedMs: number;
      telemetry: { eventCount: number; hits: number; misses: number };
      usage: { eventsBytes: number };
    };
    expect(parsed.hitRate).toBe(0.5);
    expect(parsed.estimatedTimeSavedMs).toBe(1_000);
    expect(parsed.telemetry).toEqual(
      expect.objectContaining({ eventCount: 2, hits: 1, misses: 1 })
    );
    expect(parsed.usage.eventsBytes).toBeGreaterThan(0);
  });

  it("rejects prune-only policy options on read-only commands", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const status = await runCli(["stats", "--max-size", "1GB"]);

    expect(status).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Cleanup policy options are only valid with prune"
    );
    error.mockRestore();
  });

  it("returns usage status 2 for invalid prune policy values", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const status = await runCli(["prune", "--max-size", "nope"]);

    expect(status).toBe(2);
    expect(error).toHaveBeenCalledWith(
      "maxSize must be a byte count or a size ending in B, KB, MB, GB, or TB"
    );
    error.mockRestore();
  });

  it("filters legacy entries with the requested platform", async () => {
    const cacheRoot = getCachePaths(projectRoot).cacheRoot;
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "android_old.apk"), "android");
    const ios = path.join(cacheRoot, "ios_old.app");
    fs.mkdirSync(ios);
    fs.writeFileSync(path.join(ios, "Info.plist"), "ios");
    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write);

    const status = await runCli([
      "list",
      "--project-root",
      projectRoot,
      "--platform",
      "ios",
      "--json",
    ]);
    write.mockRestore();

    expect(status).toBe(0);
    const parsed = JSON.parse(output) as {
      legacyEntries: Array<{ platform: string }>;
    };
    expect(parsed.legacyEntries).toEqual([
      expect.objectContaining({ platform: "ios" }),
    ]);
  });

  it("returns usage status 2 for unknown commands", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const status = await runCli(["unknown"]);

    expect(status).toBe(2);
    expect(error).toHaveBeenCalledWith("Unknown command: unknown");
    error.mockRestore();
  });
});
