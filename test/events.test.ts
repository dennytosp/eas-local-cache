import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  RESOLVE_EVENT_MAX_BYTES,
  RESOLVE_EVENT_MAX_COUNT,
  RESOLVE_EVENT_MAX_LOOKUP_DURATION_MS,
  RESOLVE_EVENT_MAX_TIME_SAVED_MS,
  pruneResolveEvents,
  recordResolveEvent,
  scanResolveEvents,
  summarizeResolveEvents,
  type ResolveEvent,
  type ResolveEventInput,
} from "../src/cache/events";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-events-"))
);
const providerRoot = path.join(root, "v1");
const eventsRoot = path.join(providerRoot, "events");
const entryId = "a".repeat(64);
const defaultInput: ResolveEventInput = {
  platform: "ios",
  entryId,
  outcome: "miss",
  lookupDurationMs: 12.5,
  explanationCode: "no-entry",
};

const resetRoot = (): void => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(providerRoot, { recursive: true });
};

afterEach(resetRoot, 120_000);
resetRoot();

const timestampToken = (timestamp: string): string =>
  timestamp.replaceAll("-", "").replaceAll(":", "").replace(".", "");

const uuidFor = (index: number): string => {
  const value = index.toString(16).padStart(30, "0").slice(-30);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(
    12,
    15
  )}-8${value.slice(15, 18)}-${value.slice(18, 30)}`;
};

const writeRawEvent = (
  event: ResolveEvent,
  index: number,
  overrides: { day?: string; contents?: string } = {}
): string => {
  const day = overrides.day ?? event.timestamp.slice(0, 10);
  const directory = path.join(eventsRoot, day);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(
    directory,
    `${timestampToken(event.timestamp)}-${uuidFor(index)}.json`
  );
  fs.writeFileSync(
    filePath,
    overrides.contents ?? `${JSON.stringify(event)}\n`,
    { mode: 0o600 }
  );
  return filePath;
};

const eventAt = (
  timestamp: string,
  overrides: Partial<ResolveEvent> = {}
): ResolveEvent => ({
  schemaVersion: 1,
  timestamp,
  platform: "ios",
  entryId,
  outcome: "miss",
  lookupDurationMs: 1,
  explanationCode: "no-entry",
  ...overrides,
});

describe("resolve event telemetry", () => {
  it("publishes a private immutable event in its UTC bucket", async () => {
    const nowMs = Date.parse("2026-08-13T04:05:06.789Z");
    const result = await recordResolveEvent(
      providerRoot,
      eventsRoot,
      defaultInput,
      {
        nowMs,
        randomUUID: () => "12345678-1234-4123-8123-123456789abc",
      }
    );

    expect(result.status).toBe("recorded");
    if (result.status !== "recorded") {
      throw new Error("Expected telemetry event to be recorded");
    }
    expect(path.relative(eventsRoot, result.filePath)).toBe(
      path.join(
        "2026-08-13",
        "20260813T040506789Z-12345678-1234-4123-8123-123456789abc.json"
      )
    );
    expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
    expect(
      fs
        .readdirSync(path.dirname(result.filePath))
        .some((name) => name.startsWith(".tmp-"))
    ).toBe(false);

    const scan = scanResolveEvents(eventsRoot);
    expect(scan.invalid).toEqual([]);
    expect(scan.events.map(({ event }) => event)).toEqual([
      {
        schemaVersion: 1,
        timestamp: "2026-08-13T04:05:06.789Z",
        ...defaultInput,
      },
    ]);
    expect(scan.validBytes).toBeGreaterThan(0);
    expect(scan.totalBytes).toBe(scan.validBytes);
  });

  it("rejects symlinked, oversized, malformed, and mismatched UTC records", () => {
    const timestamp = "2026-08-13T00:00:00.000Z";
    const valid = eventAt(timestamp);
    writeRawEvent(valid, 1);
    writeRawEvent(valid, 2, { contents: "not-json" });
    writeRawEvent(valid, 3, {
      contents: "x".repeat(RESOLVE_EVENT_MAX_BYTES + 1),
    });
    writeRawEvent(valid, 4, { day: "2026-08-12" });

    const symlinkPath = writeRawEvent(valid, 5);
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(
      path.join(
        eventsRoot,
        "2026-08-13",
        path.basename(writeRawEvent(valid, 6))
      ),
      symlinkPath
    );

    const scan = scanResolveEvents(eventsRoot);
    expect(scan.events).toHaveLength(2);
    expect(scan.invalid).toHaveLength(4);
    expect(scan.invalid.map(({ reason }) => reason).join("\n")).toContain(
      "size limit"
    );
    expect(scan.invalid.map(({ reason }) => reason).join("\n")).toContain(
      "regular file"
    );
    expect(scan.invalid.map(({ reason }) => reason).join("\n")).toContain(
      "UTC path"
    );
  });

  it("rejects huge finite metrics before they can corrupt aggregates", () => {
    const timestamp = "2026-08-13T00:00:00.000Z";
    writeRawEvent(
      eventAt(timestamp, { lookupDurationMs: Number.MAX_VALUE }),
      1
    );
    writeRawEvent(
      eventAt(timestamp, {
        outcome: "hit",
        explanationCode: "hit",
        lookupDurationMs: 1,
        estimatedTimeSavedMs: Number.MAX_VALUE,
      }),
      2
    );

    const scan = scanResolveEvents(eventsRoot);
    expect(scan.events).toEqual([]);
    expect(scan.invalid).toHaveLength(2);
    expect(() =>
      summarizeResolveEvents([
        eventAt(timestamp, {
          lookupDurationMs: RESOLVE_EVENT_MAX_LOOKUP_DURATION_MS + 1,
        }),
      ])
    ).toThrow("malformed fields");
    expect(() =>
      summarizeResolveEvents([
        eventAt(timestamp, {
          outcome: "hit",
          explanationCode: "hit",
          estimatedTimeSavedMs: RESOLVE_EVENT_MAX_TIME_SAVED_MS + 1,
        }),
      ])
    ).toThrow("malformed fields");
    expect(() =>
      summarizeResolveEvents(
        Array.from({ length: RESOLVE_EVENT_MAX_COUNT + 1 }, () =>
          eventAt(timestamp)
        )
      )
    ).toThrow("retained event limit");
  });

  it("skips quickly when the dedicated telemetry lock is busy", async () => {
    fs.mkdirSync(path.join(eventsRoot, ".telemetry.lock"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(eventsRoot, ".telemetry.lock", "owner.json"),
      `${JSON.stringify({
        token: "active",
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      })}\n`
    );

    const result = await recordResolveEvent(
      providerRoot,
      eventsRoot,
      defaultInput,
      { maxLockWaitMs: 0 }
    );

    expect(result).toEqual({ status: "lock-busy" });
    expect(scanResolveEvents(eventsRoot).events).toEqual([]);
  });

  it("does not lose events from concurrent provider processes", async () => {
    const writer = path.join(
      import.meta.dir,
      "fixtures",
      "telemetry-writer.ts"
    );
    const processes = Array.from({ length: 12 }, () =>
      Bun.spawn([process.execPath, writer, providerRoot, eventsRoot, entryId], {
        stdout: "pipe",
        stderr: "pipe",
      })
    );
    const exitCodes = await Promise.all(processes.map((child) => child.exited));

    if (exitCodes.some((code) => code !== 0)) {
      const errors = await Promise.all(
        processes.map((child) => new Response(child.stderr).text())
      );
      throw new Error(errors.filter(Boolean).join("\n"));
    }
    expect(scanResolveEvents(eventsRoot).events).toHaveLength(12);
  });

  it("strictly retains 90 days and at most 10,000 events after every write", async () => {
    const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
    const recentTimestamp = "2026-08-13T11:00:00.000Z";
    const expiredTimestamp = "2026-05-15T11:59:59.999Z";
    writeRawEvent(eventAt(expiredTimestamp), RESOLVE_EVENT_MAX_COUNT + 1);
    for (let index = 0; index < RESOLVE_EVENT_MAX_COUNT; index += 1) {
      writeRawEvent(eventAt(recentTimestamp), index);
    }

    const result = await recordResolveEvent(
      providerRoot,
      eventsRoot,
      defaultInput,
      { nowMs }
    );

    expect(result.status).toBe("recorded");
    const scan = scanResolveEvents(eventsRoot);
    expect(scan.events).toHaveLength(RESOLVE_EVENT_MAX_COUNT);
    expect(
      scan.events.some(({ event }) => event.timestamp === expiredTimestamp)
    ).toBe(false);
    expect(scan.events.at(-1)?.event.timestamp).toBe(
      "2026-08-13T12:00:00.000Z"
    );
  }, 120_000);

  it("removes invalid owned records so malformed files cannot evade the cap", async () => {
    const malformedPath = writeRawEvent(
      eventAt("2026-08-13T11:00:00.000Z"),
      1,
      { contents: "not-json" }
    );
    const symlinkPath = writeRawEvent(eventAt("2026-08-13T11:00:01.000Z"), 2);
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync(malformedPath, symlinkPath);
    const temporaryPath = path.join(
      eventsRoot,
      "2026-08-13",
      ".tmp-123-12345678-1234-4123-8123-123456789abc"
    );
    fs.writeFileSync(temporaryPath, "partial");

    const result = await recordResolveEvent(
      providerRoot,
      eventsRoot,
      defaultInput,
      { nowMs: Date.parse("2026-08-13T12:00:00.000Z") }
    );

    expect(result.status).toBe("recorded");
    expect(fs.existsSync(malformedPath)).toBe(false);
    expect(fs.existsSync(symlinkPath)).toBe(false);
    expect(fs.existsSync(temporaryPath)).toBe(false);
    const scan = scanResolveEvents(eventsRoot);
    expect(scan.invalid).toEqual([]);
    expect(scan.events).toHaveLength(1);
  });

  it("uses the dedicated lock for dry-run and manual retention cleanup", async () => {
    const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
    const expiredTimestamp = "2026-05-15T11:59:59.999Z";
    const expiredPath = writeRawEvent(eventAt(expiredTimestamp), 1);
    const invalidPath = writeRawEvent(eventAt("2026-08-13T11:00:00.000Z"), 2, {
      contents: "invalid",
    });

    const dryRun = await pruneResolveEvents(providerRoot, eventsRoot, {
      nowMs,
      dryRun: true,
    });
    expect(dryRun).toEqual({
      status: "pruned",
      candidates: [
        {
          filePath: invalidPath,
          timestamp: null,
          sizeBytes: fs.statSync(invalidPath).size,
          reason: "invalid",
        },
        {
          filePath: expiredPath,
          timestamp: expiredTimestamp,
          sizeBytes: fs.statSync(expiredPath).size,
          reason: "expired",
        },
      ],
      removed: [],
      removedCount: 0,
      removedBytes: 0,
    });
    expect(fs.existsSync(expiredPath)).toBe(true);
    expect(fs.existsSync(invalidPath)).toBe(true);

    const applied = await pruneResolveEvents(providerRoot, eventsRoot, {
      nowMs,
    });
    expect(applied.status).toBe("pruned");
    if (applied.status === "pruned") {
      expect(applied.removedCount).toBe(2);
      expect(applied.removedBytes).toBeGreaterThan(0);
    }
    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(fs.existsSync(invalidPath)).toBe(false);
  });

  it("returns an empty scan before the telemetry directory exists", () => {
    expect(scanResolveEvents(eventsRoot)).toEqual({
      events: [],
      invalid: [],
      validBytes: 0,
      invalidBytes: 0,
      totalBytes: 0,
    });
  });

  it("summarizes retained decisions, lookup time, and conservative savings", () => {
    const events = [
      eventAt("2026-08-13T00:00:03.000Z", {
        outcome: "hit",
        explanationCode: "hit",
        lookupDurationMs: 3,
        estimatedTimeSavedMs: 100,
      }),
      eventAt("2026-08-13T00:00:01.000Z", {
        outcome: "hit",
        explanationCode: "hit",
        lookupDurationMs: 2,
      }),
      eventAt("2026-08-13T00:00:02.000Z", {
        outcome: "miss",
        lookupDurationMs: 4,
      }),
      eventAt("2026-08-13T00:00:04.000Z", {
        outcome: "error",
        explanationCode: "provider-error",
        lookupDurationMs: 5,
      }),
    ];

    expect(summarizeResolveEvents(events)).toEqual({
      eventCount: 4,
      hits: 2,
      misses: 1,
      errors: 1,
      hitRate: 2 / 3,
      lookupDurationMs: 14,
      estimatedTimeSavedMs: 100,
      hitsWithoutEstimate: 1,
      windowStart: "2026-08-13T00:00:01.000Z",
      windowEnd: "2026-08-13T00:00:04.000Z",
    });
    expect(summarizeResolveEvents([]).hitRate).toBeNull();
  });
});
