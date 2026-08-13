import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { removeAccessRecord, touchAccessRecord } from "../src/cache/access";
import { inventoryCache } from "../src/cache/catalog";
import { doctorCache, doctorCacheDeep } from "../src/cache/doctor";
import { recordResolveEvent } from "../src/cache/events";
import {
  getCachePaths,
  getEntryId,
  getRestoreDirectory,
} from "../src/cache/paths";
import { readManifest, writeManifest } from "../src/cache/manifest";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
} from "../src/cache/store";
import { discoverZstdCodec } from "../src/cache/zstd";
import { runCli } from "../src/cli";

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

const seedCompressedEntry = async (fingerprint: string) => {
  const source = path.join(projectRoot, `${fingerprint}.apk`);
  fs.writeFileSync(source, "compressible-native-artifact".repeat(100_000));
  const artifact = await uploadCacheEntry(
    { projectRoot, platform: "android", fingerprintHash: fingerprint },
    source,
    { compressionMode: "zstd" }
  );
  const paths = getCachePaths(projectRoot);
  const entryId = getEntryId("android", fingerprint);
  return { source, artifact: artifact!, entryId, paths };
};

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

  it("reports malformed trusted LAN state without contacting peers", async () => {
    const entry = await seedEntry(
      "doctor-lan-state",
      "healthy",
      "2026-08-12T00:00:00.000Z"
    );
    fs.mkdirSync(entry.paths.stateRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(entry.paths.stateRoot, "lan.json"), "{", {
      mode: 0o600,
    });

    const report = doctorCache(projectRoot);

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "invalid-lan-state" })
    );
    expect(fs.existsSync(entry.artifact)).toBe(true);
  });

  it("validates existing restore integrity without mutating it", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedEntry("doctor-restore");
    expect(
      (
        await resolveCacheEntryDetailed({
          projectRoot,
          platform: "android",
          fingerprintHash: "doctor-restore",
        })
      ).outcome
    ).toBe("hit");
    const restore = getRestoreDirectory(
      seeded.paths,
      "android",
      seeded.entryId
    );
    fs.appendFileSync(path.join(restore, "artifact.apk"), "damage");

    const report = doctorCache(projectRoot);
    expect(report.healthy).toBe(false);
    expect(report.checkedRestores).toBe(1);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "restore-integrity-mismatch" })
    );
    expect(fs.existsSync(restore)).toBe(true);
  });

  it("deep doctor fails explicitly without zstd and never publishes a restore", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedEntry("doctor-deep-unavailable");
    const restore = getRestoreDirectory(
      seeded.paths,
      "android",
      seeded.entryId
    );

    const report = await doctorCacheDeep(projectRoot, { codec: null });

    expect(report.deep).toBe(true);
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "zstd-unavailable",
        severity: "warning",
      })
    );
    expect(fs.existsSync(restore)).toBe(false);
  });

  it("deep doctor verifies compressed data in disposable staging", async () => {
    const codec = discoverZstdCodec();
    if (!codec) return;
    const seeded = await seedCompressedEntry("doctor-deep");
    const report = await doctorCacheDeep(projectRoot, { codec });

    expect(report).toMatchObject({ healthy: true, deep: true });
    expect(
      fs.existsSync(
        getRestoreDirectory(seeded.paths, "android", seeded.entryId)
      )
    ).toBe(false);
    expect(fs.readdirSync(seeded.paths.restoreStagingRoot)).toEqual([]);
  });

  it("exposes deep doctor through the CLI and rejects it elsewhere", async () => {
    if (!discoverZstdCodec()) return;
    await seedCompressedEntry("doctor-deep-cli");
    let output = "";
    const write = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    expect(
      await runCli([
        "doctor",
        "--project-root",
        projectRoot,
        "--deep",
        "--json",
      ])
    ).toBe(0);
    write.mockRestore();
    expect(JSON.parse(output)).toMatchObject({ healthy: true, deep: true });

    const error = spyOn(console, "error").mockImplementation(() => {});
    expect(await runCli(["stats", "--deep"])).toBe(2);
    expect(error).toHaveBeenCalledWith("--deep is only valid with doctor");
    error.mockRestore();
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
        expect(parsed.latestBuild).toMatchObject({
          platform: "android",
          fingerprint: "cli",
        });
        expect(parsed.hitRate).toBeNull();
        expect(parsed.estimatedTimeSavedMs).toBeNull();
      } else {
        expect(parsed.entries).toBeArrayOfSize(1);
        expect(parsed.legacyEntries).toEqual([]);
      }
    }
  });

  it("reports the latest build and lists entries newest-first with deterministic ties", async () => {
    const oldest = await seedEntry(
      "oldest",
      "oldest",
      "2026-08-13T04:00:00.000Z"
    );
    const tiedA = await seedEntry(
      "tied-a",
      "tied-a",
      "2026-08-13T03:00:00.000Z"
    );
    const tiedB = await seedEntry(
      "tied-b",
      "tied-b",
      "2026-08-13T02:00:00.000Z"
    );
    const createdAt = new Map([
      [oldest.entryId, "2026-08-11T00:00:00.000Z"],
      [tiedA.entryId, "2026-08-12T00:00:00.000Z"],
      [tiedB.entryId, "2026-08-12T00:00:00.000Z"],
    ]);
    for (const [entryId, timestamp] of createdAt) {
      const entryDirectory = path.join(
        oldest.paths.entriesRoot,
        "android",
        entryId
      );
      writeManifest(entryDirectory, {
        ...readManifest(entryDirectory),
        createdAt: timestamp,
      });
    }

    const readJson = async (command: "stats" | "list") => {
      let output = "";
      const write = spyOn(process.stdout, "write").mockImplementation(((
        chunk: string | Uint8Array
      ) => {
        output += chunk.toString();
        return true;
      }) as typeof process.stdout.write);
      expect(
        await runCli([command, "--project-root", projectRoot, "--json"])
      ).toBe(0);
      write.mockRestore();
      return JSON.parse(output) as {
        latestBuild: { entryId: string; createdAt: string };
        entries: Array<{ entryId: string; createdAt: string }>;
      };
    };

    const expectedTies = [tiedA.entryId, tiedB.entryId].sort();
    const list = await readJson("list");
    expect(list.entries.map((entry) => entry.entryId)).toEqual([
      ...expectedTies,
      oldest.entryId,
    ]);
    const stats = await readJson("stats");
    const expectedFingerprint =
      expectedTies[0] === tiedA.entryId ? "tied-a" : "tied-b";
    expect(stats.latestBuild).toMatchObject({
      entryId: expectedTies[0],
      createdAt: "2026-08-12T00:00:00.000Z",
    });

    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await runCli(["stats", "--project-root", projectRoot])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      `Latest build: android ${expectedFingerprint} created 2026-08-12T00:00:00.000Z`
    );
    log.mockRestore();
  });

  it("prints an explicit unavailable latest build for an empty cache", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    expect(await runCli(["stats", "--project-root", projectRoot])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      "Latest build: unavailable (no versioned cache entries)"
    );
    log.mockRestore();
  });

  it("reports exact compression and restore storage in stats and list JSON", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedEntry("cli-compression");
    expect(
      (
        await resolveCacheEntryDetailed({
          projectRoot,
          platform: "android",
          fingerprintHash: "cli-compression",
        })
      ).outcome
    ).toBe("hit");
    const catalog = inventoryCache(projectRoot);
    const entry = catalog.entries[0]!;

    const outputs: Record<string, unknown> = {};
    for (const command of ["stats", "list"]) {
      let output = "";
      const write = spyOn(process.stdout, "write").mockImplementation(((
        chunk: string | Uint8Array
      ) => {
        output += chunk.toString();
        return true;
      }) as typeof process.stdout.write);
      expect(
        await runCli([command, "--project-root", projectRoot, "--json"])
      ).toBe(0);
      write.mockRestore();
      outputs[command] = JSON.parse(output) as unknown;
    }

    expect(outputs.stats).toMatchObject({
      compression: {
        compressedEntries: 1,
        logicalArtifactBytes: entry.logicalArtifactBytes,
        payloadBytes: entry.payloadBytes,
        grossSavedBytes: entry.grossCompressionSavedBytes,
        restoreBytes: entry.restoreBytes,
        netSavedBytes: entry.grossCompressionSavedBytes - entry.restoreBytes,
      },
    });
    expect(outputs.list).toMatchObject({
      entries: [
        {
          encoding: "zstd",
          logicalArtifactBytes: entry.logicalArtifactBytes,
          payloadBytes: entry.payloadBytes,
          compressionRatio: entry.compressionRatio,
          grossCompressionSavedBytes: entry.grossCompressionSavedBytes,
          restoreBytes: entry.restoreBytes,
        },
      ],
    });
    expect(
      fs.existsSync(
        getRestoreDirectory(seeded.paths, "android", seeded.entryId)
      )
    ).toBe(true);
  });

  it("rejects impossible compression savings without crashing inspector commands", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedEntry("hostile-compression-accounting");
    const entryDirectory = path.dirname(seeded.artifact);
    const manifest = readManifest(entryDirectory);
    expect(manifest.schemaVersion).toBe(2);
    if (manifest.schemaVersion !== 2) return;
    fs.writeFileSync(
      path.join(entryDirectory, "manifest.json"),
      `${JSON.stringify(
        {
          ...manifest,
          payload: { ...manifest.payload, schema1EquivalentBytes: 1 },
        },
        null,
        2
      )}\n`
    );

    const catalog = inventoryCache(projectRoot);
    expect(catalog.entries).toEqual([]);
    expect(catalog.invalidEntries).toHaveLength(1);
    expect(catalog.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid-entry",
        message:
          "Compressed cache metadata cannot claim less storage than the committed entry",
      })
    );

    for (const command of ["stats", "list", "doctor"] as const) {
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

      expect(status).toBe(1);
      const parsed = JSON.parse(output) as { issues: unknown[] };
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid-entry",
            severity: "error",
          }),
        ])
      );
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
