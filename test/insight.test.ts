import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  EVIDENCE_CATEGORIES,
  INSIGHT_FILENAME,
  MAX_INSIGHT_BYTES,
  MAX_INSIGHT_SOURCES,
  createCacheInsight,
  diffInsightEnvironment,
  diffInsights,
  getInsightIdentity,
  getTopEvidenceGroups,
  readInsight,
  sanitizeFingerprintSources,
  selectClosestInsight,
  writeInsightAtomically,
  type CacheInsight,
  type FingerprintSnapshot,
  type InsightCandidate,
  type InsightSource,
  type CacheInsightV1,
} from "../src/cache/insight";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const makeRoot = () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-insight-"))
  );
  roots.push(root);
  return root;
};

const source = (
  comparatorHash: string,
  digest: string | null,
  categories: InsightSource["categories"] = ["other"],
  occurrence = 0
): InsightSource => ({
  type: "contents",
  comparatorHash: comparatorHash.padEnd(64, "0"),
  occurrence,
  digest,
  categories,
});

const snapshot = (
  sources: InsightSource[],
  overrides: Partial<FingerprintSnapshot> = {}
): FingerprintSnapshot => ({
  platform: "ios",
  fingerprintHash: "fingerprint-hash",
  capturedAt: "2026-08-13T01:02:03.000Z",
  fingerprintEngineVersion: "0.20.7",
  runProfile: { configuration: "Debug", scheme: "default" },
  sources,
  ...overrides,
});

const insight = (
  sources: InsightSource[],
  entryId = "a".repeat(64),
  overrides: Partial<FingerprintSnapshot> = {}
): CacheInsight => createCacheInsight(snapshot(sources, overrides), entryId);

describe("fingerprint source sanitization", () => {
  it("hashes identities, keeps duplicate order, and stores only fixed categories", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "ios"));
    fs.writeFileSync(path.join(root, "ios", "Podfile"), "pod contents");

    const result = sanitizeFingerprintSources(root, [
      {
        type: "file",
        filePath: "ios/Podfile",
        hash: "ABC123",
        reasons: ["bareNativeDir", "unknown-secret-reason"],
      },
      {
        type: "file",
        filePath: "ios/Podfile",
        hash: null,
        reasons: ["expoConfig"],
      },
      {
        type: "contents",
        id: "secret-identity",
        contents: "secret-contents",
        hash: "00FF",
        reasons: ["package:react-native"],
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.[0]).toMatchObject({
      occurrence: 0,
      displayPath: "ios/Podfile",
      digest: "abc123",
      categories: ["native-project", "other"],
    });
    expect(result?.[1]).toMatchObject({
      occurrence: 1,
      digest: null,
      categories: ["expo-config"],
    });
    expect(result?.[0]?.comparatorHash).toBe(result?.[1]?.comparatorHash);
    expect(result?.[2]?.categories).toEqual(["native-dependencies"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-identity");
    expect(serialized).not.toContain("secret-contents");
    expect(serialized).not.toContain("unknown-secret-reason");
    expect(EVIDENCE_CATEGORIES).toContain(result?.[2]?.categories[0]!);
  });

  it("omits unsafe displays and rejects incomplete or oversized snapshots", () => {
    const root = makeRoot();
    const outside = path.join(path.dirname(root), "outside-native-file");
    fs.writeFileSync(outside, "outside");
    const symlink = path.join(root, "linked-native-file");
    fs.symlinkSync(outside, symlink);

    const result = sanitizeFingerprintSources(root, [
      { type: "file", filePath: outside, hash: "aa", reasons: [] },
      { type: "file", filePath: symlink, hash: "bb", reasons: [] },
    ]);
    expect(result?.every((item) => item.displayPath === undefined)).toBe(true);
    expect(
      sanitizeFingerprintSources(root, [
        { type: "contents", hash: "aa", reasons: [] },
      ])
    ).toBeNull();
    expect(
      sanitizeFingerprintSources(root, [
        {
          type: "contents",
          id: "malformed-digest",
          hash: "not-a-hex-digest",
          reasons: [],
        },
      ])
    ).toBeNull();
    expect(
      sanitizeFingerprintSources(
        root,
        Array.from({ length: MAX_INSIGHT_SOURCES + 1 }, (_, index) => ({
          type: "contents" as const,
          id: `id-${index}`,
          hash: "aa",
          reasons: [],
        }))
      )
    ).toBeNull();
    fs.rmSync(outside, { force: true });
  });
});

describe("insight persistence", () => {
  it("atomically round-trips a private regular file", () => {
    const root = makeRoot();
    const record = insight([source("1", "aa")]);

    writeInsightAtomically(root, record);

    expect(readInsight(root)).toEqual(record);
    expect(fs.statSync(path.join(root, INSIGHT_FILENAME)).mode & 0o777).toBe(
      0o600
    );
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
    expect(() => writeInsightAtomically(root, record)).toThrow(
      "already exists"
    );
  });

  it("returns null when absent and rejects symlinked, oversized, or malformed records", () => {
    const root = makeRoot();
    expect(readInsight(root)).toBeNull();

    const target = path.join(root, "target.json");
    fs.writeFileSync(target, JSON.stringify(insight([])));
    fs.symlinkSync(target, path.join(root, INSIGHT_FILENAME));
    expect(() => readInsight(root)).toThrow();
    fs.unlinkSync(path.join(root, INSIGHT_FILENAME));

    fs.writeFileSync(
      path.join(root, INSIGHT_FILENAME),
      Buffer.alloc(MAX_INSIGHT_BYTES + 1)
    );
    expect(() => readInsight(root)).toThrow("1 MiB");
    fs.writeFileSync(path.join(root, INSIGHT_FILENAME), "{}");
    expect(() => readInsight(root)).toThrow("malformed");

    const traversal = {
      ...insight([source("1", "aa")]),
      sources: [
        {
          ...source("1", "aa"),
          displayPath: "ios/../../private/file",
        },
      ],
    };
    fs.writeFileSync(
      path.join(root, INSIGHT_FILENAME),
      JSON.stringify(traversal)
    );
    expect(() => readInsight(root)).toThrow("malformed");
  });

  it("omits an insight rather than serializing a partial over-limit snapshot", () => {
    const manySources = Array.from(
      { length: MAX_INSIGHT_SOURCES },
      (_, index) =>
        source(index.toString(16).padStart(64, "0"), "a".repeat(256), [
          "expo-config",
        ])
    );
    expect(() => insight(manySources)).toThrow("1 MiB");
  });

  it("reads schema 1 and normalizes its single identity without rewriting it", () => {
    const root = makeRoot();
    const legacy: CacheInsightV1 = {
      schemaVersion: 1,
      platform: "ios",
      entryId: "a".repeat(64),
      fingerprintHash: "legacy-expo-hash",
      capturedAt: "2026-08-13T01:02:03.000Z",
      fingerprintEngineVersion: "0.20.7",
      runProfile: { configuration: "Debug", scheme: "default" },
      sources: [],
    };
    fs.writeFileSync(
      path.join(root, INSIGHT_FILENAME),
      `${JSON.stringify(legacy)}\n`
    );

    const restored = readInsight(root);
    expect(restored).toEqual(legacy);
    expect(getInsightIdentity(restored!)).toEqual({
      fingerprintHash: "legacy-expo-hash",
      baseFingerprintHash: "legacy-expo-hash",
      effectiveFingerprintHash: "legacy-expo-hash",
      keySchema: "expo-base",
      toolchainMode: "off",
      toolchain: null,
      environmentKeyDigest: null,
    });
  });

  it("strictly validates schema 2 aliases and sanitized fixed toolchain fields", () => {
    const root = makeRoot();
    const record = createCacheInsight(
      snapshot([], {
        fingerprintHash: `elc-env-v1:${"a".repeat(64)}`,
        baseFingerprintHash: "expo-base-hash",
        effectiveFingerprintHash: `elc-env-v1:${"a".repeat(64)}`,
        keySchema: "environment-v1",
        toolchainMode: "safe",
        toolchain: {
          platform: "ios",
          hostArch: "arm64",
          xcodeBuildVersion: "17A1",
          simulatorSdkBuildVersion: "23A1",
        },
        environmentKeyDigest: "b".repeat(64),
      }),
      "c".repeat(64)
    );
    writeInsightAtomically(root, record);
    expect(readInsight(root)).toEqual(record);
    expect(JSON.stringify(record)).not.toContain(
      "optional-team-defined-context"
    );
    expect(record.schemaVersion).toBe(2);
    if (record.schemaVersion !== 2)
      throw new Error("Expected schema 2 insight");

    for (const malformed of [
      { ...record, effectiveFingerprintHash: "different" },
      {
        ...record,
        fingerprintHash: `elc-env-v1:${"A".repeat(64)}`,
        effectiveFingerprintHash: `elc-env-v1:${"A".repeat(64)}`,
      },
      { ...record, toolchain: { ...record.toolchain, unexpected: "raw" } },
      {
        ...record,
        toolchain: { ...record.toolchain, hostArch: "riscv64" },
      },
      {
        ...record,
        toolchain: { ...record.toolchain, hostArch: "other" },
      },
      { ...record, toolchainMode: "strict" },
      {
        ...record,
        toolchain: { ...record.toolchain, xcodeVersion: "16.4" },
      },
      { ...record, environmentKeyDigest: "not-a-digest" },
    ]) {
      const malformedRoot = makeRoot();
      fs.writeFileSync(
        path.join(malformedRoot, INSIGHT_FILENAME),
        JSON.stringify(malformed)
      );
      expect(() => readInsight(malformedRoot)).toThrow("malformed");
    }

    const offRoot = makeRoot();
    const offRecord = {
      ...record,
      toolchainMode: "off" as const,
      toolchain: null,
    };
    fs.writeFileSync(
      path.join(offRoot, INSIGHT_FILENAME),
      JSON.stringify(offRecord)
    );
    expect(readInsight(offRoot)).toEqual(offRecord);

    const offWithoutManualContextRoot = makeRoot();
    fs.writeFileSync(
      path.join(offWithoutManualContextRoot, INSIGHT_FILENAME),
      JSON.stringify({ ...offRecord, environmentKeyDigest: null })
    );
    expect(() => readInsight(offWithoutManualContextRoot)).toThrow("malformed");
  });

  it("requires exact Android enums and safe or strict field sets", () => {
    const effectiveHash = `elc-env-v1:${"d".repeat(64)}`;
    const safe = createCacheInsight(
      snapshot([], {
        platform: "android",
        runProfile: { variant: "debug", allArch: false },
        fingerprintHash: effectiveHash,
        baseFingerprintHash: "opaque:expo/base/hash",
        effectiveFingerprintHash: effectiveHash,
        keySchema: "environment-v1",
        toolchainMode: "safe",
        toolchain: {
          platform: "android",
          hostArch: "arm64",
          javaSpecificationVersion: "21",
          javaVendorFamily: "adoptium",
          jvmArch: "arm64",
          gradleVersion: "8.14.3",
          targetArchitecture: "arm64-v8a",
        },
        environmentKeyDigest: null,
      }),
      "e".repeat(64)
    );
    const strict = {
      ...safe,
      toolchainMode: "strict" as const,
      toolchain: {
        ...safe.toolchain,
        javaRuntimeVersion: "21.0.7+6-LTS",
        vmFamily: "hotspot",
        gradleDistributionBasename: "gradle-8.14.3-bin.zip",
      },
    };

    for (const valid of [safe, strict]) {
      const root = makeRoot();
      fs.writeFileSync(
        path.join(root, INSIGHT_FILENAME),
        JSON.stringify(valid)
      );
      expect(JSON.stringify(readInsight(root))).toBe(JSON.stringify(valid));
    }

    for (const malformed of [
      { ...safe, toolchainMode: "strict" },
      {
        ...safe,
        toolchain: { ...safe.toolchain, javaRuntimeVersion: "21.0.7" },
      },
      {
        ...safe,
        toolchain: { ...safe.toolchain, javaVendorFamily: "private-vendor" },
      },
      { ...safe, toolchain: { ...safe.toolchain, jvmArch: "riscv64" } },
      { ...safe, toolchain: { ...safe.toolchain, jvmArch: "other" } },
      {
        ...safe,
        toolchain: { ...safe.toolchain, targetArchitecture: "mips" },
      },
      { ...strict, toolchain: { ...strict.toolchain, vmFamily: "custom-vm" } },
    ]) {
      const root = makeRoot();
      fs.writeFileSync(
        path.join(root, INSIGHT_FILENAME),
        JSON.stringify(malformed)
      );
      expect(() => readInsight(root)).toThrow("malformed");
    }
  });

  it("accepts complete Android SDK signals while retaining legacy schema-2 insight compatibility", () => {
    const effectiveHash = `elc-env-v1:${"f".repeat(64)}`;
    const legacy = createCacheInsight(
      snapshot([], {
        platform: "android",
        runProfile: { variant: "debug", allArch: true },
        fingerprintHash: effectiveHash,
        baseFingerprintHash: "expo-base-hash",
        effectiveFingerprintHash: effectiveHash,
        keySchema: "environment-v1",
        toolchainMode: "safe",
        toolchain: {
          platform: "android",
          hostArch: "arm64",
          javaSpecificationVersion: "21",
          javaVendorFamily: "adoptium",
          jvmArch: "arm64",
          gradleVersion: "8.14.3",
          targetArchitecture: "all",
        },
        environmentKeyDigest: null,
      }),
      "1".repeat(64)
    );
    const current = {
      ...legacy,
      toolchain: {
        ...legacy.toolchain,
        compileSdkVersion: "35",
        androidSdkPlatformRevision: "2",
        buildToolsVersion: "35.0.0",
      },
    };

    for (const valid of [legacy, current]) {
      const root = makeRoot();
      fs.writeFileSync(
        path.join(root, INSIGHT_FILENAME),
        JSON.stringify(valid)
      );
      expect(JSON.stringify(readInsight(root))).toBe(JSON.stringify(valid));
    }

    for (const toolchain of [
      { ...current.toolchain, buildToolsVersion: undefined },
      { ...current.toolchain, compileSdkVersion: "android-35" },
      { ...current.toolchain, androidSdkPlatformRevision: "/private/sdk" },
    ]) {
      const root = makeRoot();
      fs.writeFileSync(
        path.join(root, INSIGHT_FILENAME),
        JSON.stringify({ ...current, toolchain })
      );
      expect(() => readInsight(root)).toThrow("malformed");
    }
  });
});

describe("insight diffing and candidate ranking", () => {
  it("matches duplicate occurrences and groups changed sources deterministically", () => {
    const before = insight([
      source("1", "aa", ["expo-config"]),
      source("1", "bb", ["native-project"], 1),
      source("2", "cc", ["other"]),
      source("3", "dd", ["native-dependencies"]),
    ]);
    const after = insight([
      source("1", "ff", ["expo-config"]),
      source("1", "bb", ["native-project"], 1),
      source("3", "dd", ["native-dependencies"]),
      source("4", "ee", ["native-dependencies"]),
    ]);

    const diff = diffInsights(before, after);
    expect({
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      total: diff.total,
    }).toEqual({ added: 1, removed: 1, changed: 1, total: 3 });
    expect(diff.groups).toEqual([
      { category: "expo-config", count: 1 },
      { category: "native-dependencies", count: 1 },
      { category: "other", count: 1 },
    ]);
    expect(
      getTopEvidenceGroups({
        groups: [...diff.groups, { category: "native-project", count: 1 }],
      })
    ).toHaveLength(3);
  });

  it("selects minimum diff then newest access, creation, and entry ID", () => {
    const current = snapshot([source("1", "aa")]);
    const candidates: InsightCandidate[] = [
      {
        insight: insight([source("1", "bb")], "b".repeat(64)),
        entryId: "b".repeat(64),
        createdAt: "2026-08-10T00:00:00.000Z",
        lastAccessAt: "2026-08-12T00:00:00.000Z",
      },
      {
        insight: insight([source("1", "bb")], "a".repeat(64)),
        entryId: "a".repeat(64),
        createdAt: "2026-08-11T00:00:00.000Z",
        lastAccessAt: "2026-08-12T00:00:00.000Z",
      },
      {
        insight: insight(
          [source("1", "bb"), source("2", "cc")],
          "0".repeat(64)
        ),
        entryId: "0".repeat(64),
        createdAt: "2026-08-13T00:00:00.000Z",
        lastAccessAt: "2026-08-13T00:00:00.000Z",
      },
      {
        insight: insight([source("1", "bb")], "c".repeat(64)),
        entryId: "c".repeat(64),
        createdAt: "2026-08-11T00:00:00.000Z",
        lastAccessAt: "2026-08-12T00:00:00.000Z",
      },
    ];

    const selected = selectClosestInsight(current, candidates);
    expect(selected.status).toBe("match");
    if (selected.status === "match") {
      expect(selected.candidate.entryId).toBe("a".repeat(64));
      expect(selected.diff.total).toBe(1);
    }
  });

  it("keeps profile differences as explainable evidence but not engine changes", () => {
    const current = snapshot([]);
    const profileResult = selectClosestInsight(current, [
      {
        insight: insight([], "a".repeat(64), {
          runProfile: { configuration: "Release", scheme: "default" },
        }),
        entryId: "a".repeat(64),
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    ]);
    expect(profileResult.status).toBe("match");
    if (profileResult.status === "match") {
      expect(profileResult.environmentDiff.groups).toEqual([
        { category: "build-profile", count: 1 },
      ]);
    }
    expect(
      selectClosestInsight(current, [
        {
          insight: insight([], "b".repeat(64), {
            fingerprintEngineVersion: "99.0.0",
          }),
          entryId: "b".repeat(64),
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ]).status
    ).toBe("fingerprint-engine-mismatch");
  });

  it("reports only a schema upgrade for legacy environment evidence", () => {
    const before: CacheInsightV1 = {
      schemaVersion: 1,
      platform: "ios",
      entryId: "a".repeat(64),
      fingerprintHash: "expo-hash",
      capturedAt: "2026-08-13T01:02:03.000Z",
      fingerprintEngineVersion: "0.20.7",
      runProfile: { configuration: "Debug", scheme: "default" },
      sources: [],
    };
    const after = snapshot([], {
      fingerprintHash: `elc-env-v1:${"b".repeat(64)}`,
      baseFingerprintHash: "expo-hash",
      effectiveFingerprintHash: `elc-env-v1:${"b".repeat(64)}`,
      keySchema: "environment-v1",
      toolchainMode: "safe",
      toolchain: {
        platform: "ios",
        hostArch: "arm64",
        xcodeBuildVersion: "17A1",
        simulatorSdkBuildVersion: "23A1",
      },
      environmentKeyDigest: null,
    });
    expect(diffInsightEnvironment(before, after)).toEqual({
      items: [{ field: "keySchema", category: "key-schema" }],
      total: 1,
      groups: [{ category: "key-schema", count: 1 }],
    });
  });
});
