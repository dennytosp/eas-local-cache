import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEFAULT_CACHE_POLICY,
  formatSizeBytes,
  normalizeCacheOptions,
  parseSizeBytes,
} from "../src/cache/options";
import { readPolicyState, writePolicyState } from "../src/cache/policy-state";

describe("cache provider options", () => {
  it("uses bounded zero-config defaults", () => {
    expect(normalizeCacheOptions()).toEqual({
      maxSizeBytes: 20 * 1024 ** 3,
      maxEntries: 50,
      retentionMs: 14 * 24 * 60 * 60 * 1000,
      autoPrune: true,
    });
    expect(Object.isFrozen(DEFAULT_CACHE_POLICY)).toBe(true);
  });

  it("normalizes every supported option", () => {
    expect(
      normalizeCacheOptions({
        maxSize: "1.5 GB",
        maxEntries: 7,
        retentionDays: 0.5,
        autoPrune: false,
      })
    ).toEqual({
      maxSizeBytes: 1.5 * 1024 ** 3,
      maxEntries: 7,
      retentionMs: 12 * 60 * 60 * 1000,
      autoPrune: false,
    });
  });

  it("lets each limit be disabled independently", () => {
    expect(
      normalizeCacheOptions({
        maxSize: null,
        maxEntries: null,
        retentionDays: null,
      })
    ).toEqual({
      maxSizeBytes: null,
      maxEntries: null,
      retentionMs: null,
      autoPrune: true,
    });
  });

  it("accepts zero limits and numeric byte counts", () => {
    expect(
      normalizeCacheOptions({
        maxSize: 0,
        maxEntries: 0,
        retentionDays: 0,
      })
    ).toEqual({
      maxSizeBytes: 0,
      maxEntries: 0,
      retentionMs: 0,
      autoPrune: true,
    });
    expect(parseSizeBytes(4096)).toBe(4096);
  });

  it("parses binary B through TB units case-insensitively", () => {
    expect(parseSizeBytes("2B")).toBe(2);
    expect(parseSizeBytes("2 kb")).toBe(2 * 1024);
    expect(parseSizeBytes(" 3 MB ")).toBe(3 * 1024 ** 2);
    expect(parseSizeBytes("4gb")).toBe(4 * 1024 ** 3);
    expect(parseSizeBytes(".5 TB")).toBe(0.5 * 1024 ** 4);
  });

  it("rejects malformed and unsafe sizes", () => {
    const invalidSizes: Array<string | number> = [
      "",
      "1024",
      "1KiB",
      "1PB",
      "one GB",
      "-1GB",
      "0.1KB",
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "8192TB",
    ];

    for (const value of invalidSizes) {
      expect(() => parseSizeBytes(value)).toThrow();
    }
  });

  it("rejects invalid entry, retention, and automatic cleanup options", () => {
    expect(() => normalizeCacheOptions({ maxEntries: -1 })).toThrow();
    expect(() => normalizeCacheOptions({ maxEntries: 1.5 })).toThrow();
    expect(() =>
      normalizeCacheOptions({ maxEntries: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow();
    expect(() => normalizeCacheOptions({ retentionDays: -1 })).toThrow();
    expect(() =>
      normalizeCacheOptions({ retentionDays: Number.POSITIVE_INFINITY })
    ).toThrow();
    expect(() =>
      normalizeCacheOptions({ autoPrune: "yes" as unknown as boolean })
    ).toThrow();
    expect(() =>
      normalizeCacheOptions(null as unknown as Record<string, never>)
    ).toThrow();
  });

  it("formats byte counts using the same binary units", () => {
    expect(formatSizeBytes(0)).toBe("0B");
    expect(formatSizeBytes(1024)).toBe("1KB");
    expect(formatSizeBytes(1536)).toBe("1.5KB");
    expect(formatSizeBytes(20 * 1024 ** 3)).toBe("20GB");
    expect(() => formatSizeBytes(-1)).toThrow();
  });
});

describe("cache policy state", () => {
  it("round-trips a normalized policy atomically", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-policy-"))
    );
    const providerRoot = path.join(root, "provider");
    const stateRoot = path.join(providerRoot, "state");
    fs.mkdirSync(providerRoot);
    const policy = normalizeCacheOptions({
      maxSize: "3GB",
      maxEntries: 8,
      retentionDays: 2,
      autoPrune: false,
    });

    try {
      expect(readPolicyState(providerRoot, stateRoot)).toEqual(
        DEFAULT_CACHE_POLICY
      );
      writePolicyState(
        providerRoot,
        stateRoot,
        policy,
        new Date("2026-08-13T00:00:00.000Z")
      );
      expect(readPolicyState(providerRoot, stateRoot)).toEqual(policy);
      expect(fs.readdirSync(stateRoot)).toEqual(["policy.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked policy state root", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-policy-link-"))
    );
    const providerRoot = path.join(root, "provider");
    const outside = path.join(root, "outside");
    const stateRoot = path.join(providerRoot, "state");
    fs.mkdirSync(providerRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, stateRoot);

    try {
      expect(() => readPolicyState(providerRoot, stateRoot)).toThrow();
      expect(() =>
        writePolicyState(providerRoot, stateRoot, normalizeCacheOptions())
      ).toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
