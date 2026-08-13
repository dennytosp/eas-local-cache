import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { readInsight } from "../src/cache/insight";
import { scanResolveEvents } from "../src/cache/events";
import { getCachePaths } from "../src/cache/paths";
import { createProviderFixture } from "./fixtures/provider-fixture";

const {
  projectRoot,
  cacheDir,
  calculateFingerprintHashCallback,
  calculateFingerprintHash,
  resolveBuildCache,
  uploadBuildCache,
  resolveProps,
  uploadProps,
  calculateProps,
  installFakeFingerprintEngine,
  makeApk,
  makeAppBundle,
  entryDirectory,
} = createProviderFixture();

describe("provider resolution", () => {
  it("disables caching before fingerprinting when compression is invalid", async () => {
    expect(
      await calculateFingerprintHashCallback(calculateProps("android"), {
        toolchain: "off",
        compression: "gzip",
      } as never)
    ).toBeNull();
  });

  it("records a miss without creating an artifact entry", async () => {
    const result = await resolveBuildCache(
      resolveProps("android", "abc123"),
      {}
    );

    expect(result).toBeNull();
    const paths = getCachePaths(projectRoot);
    expect(fs.existsSync(paths.entriesRoot)).toBe(false);
    expect(scanResolveEvents(paths.eventsRoot).events).toHaveLength(1);
  });

  it("preserves Expo hash parity and publishes bounded insight telemetry", async () => {
    installFakeFingerprintEngine("lifecycle-hash");

    const firstHash = await calculateFingerprintHash(
      calculateProps("android"),
      {}
    );
    expect(firstHash).toBe("lifecycle-hash");
    expect(
      await resolveBuildCache(resolveProps("android", "lifecycle-hash"), {})
    ).toBeNull();

    const apk = makeApk("lifecycle.apk");
    const secondHash = await calculateFingerprintHash(
      calculateProps("android"),
      {}
    );
    expect(secondHash).toBe(firstHash);
    const cached = await uploadBuildCache(
      uploadProps("android", "lifecycle-hash", apk),
      {}
    );
    expect(cached).not.toBeNull();

    const insight = readInsight(entryDirectory("android", "lifecycle-hash"));
    expect(insight?.fingerprintHash).toBe("lifecycle-hash");
    expect(JSON.stringify(insight)).not.toContain("must-not-persist");

    await calculateFingerprintHash(calculateProps("android"), {});
    expect(
      await resolveBuildCache(resolveProps("android", "lifecycle-hash"), {})
    ).toBe(cached);
    const events = scanResolveEvents(getCachePaths(projectRoot).eventsRoot);
    expect(events.events.map(({ event }) => event.outcome)).toEqual([
      "miss",
      "hit",
    ]);
  });

  it("explains an Expo config fingerprint change from prior evidence", async () => {
    installFakeFingerprintEngine("fallback");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "config-a";
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST = "aaaa";
      await calculateFingerprintHash(calculateProps("android"), {});
      await resolveBuildCache(resolveProps("android", "config-a"), {});
      const apk = makeApk("config-a.apk");
      await calculateFingerprintHash(calculateProps("android"), {});
      await uploadBuildCache(uploadProps("android", "config-a", apk), {});

      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "config-b";
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST = "bbbb";
      await calculateFingerprintHash(calculateProps("android"), {});
      expect(
        await resolveBuildCache(resolveProps("android", "config-b"), {})
      ).toBeNull();
      expect(log).toHaveBeenCalledWith(
        "Possible cause: Expo config or config plugins changed (1 source)"
      );
    } finally {
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH;
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST;
      log.mockRestore();
    }
  });

  it("separates manual environment context without persisting the raw key", async () => {
    installFakeFingerprintEngine("environment-base");
    const options = {
      toolchain: "off" as const,
      environmentKey: "private-environment-context",
    };
    const props = calculateProps("ios", projectRoot, {
      configuration: "Debug",
    });
    const fingerprintHash = await calculateFingerprintHashCallback(
      props,
      options
    );
    expect(fingerprintHash).toMatch(/^elc-env-v1:[a-f0-9]{64}$/);
    await resolveBuildCache(
      resolveProps("ios", fingerprintHash!, projectRoot, props.runOptions),
      options
    );
    await calculateFingerprintHashCallback(props, options);
    await uploadBuildCache(
      uploadProps(
        "ios",
        fingerprintHash!,
        makeAppBundle("Environment.app"),
        projectRoot,
        props.runOptions
      ),
      options
    );

    const insight = readInsight(entryDirectory("ios", fingerprintHash!));
    expect(insight?.schemaVersion).toBe(2);
    expect(JSON.stringify(insight)).not.toContain(
      "private-environment-context"
    );
  });

  it("expires an abandoned build context before correlating a later build", async () => {
    installFakeFingerprintEngine("expired-context");
    let wallTimeMs = Date.now();
    const dateNow = spyOn(Date, "now").mockImplementation(() => wallTimeMs);
    try {
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "expired-context";
      await calculateFingerprintHash(calculateProps("android"), {});
      await resolveBuildCache(resolveProps("android", "expired-context"), {});

      wallTimeMs += 30 * 60 * 1000 + 1;
      await calculateFingerprintHash(calculateProps("android"), {});
      await resolveBuildCache(resolveProps("android", "expired-context"), {});

      const apk = makeApk("expired-context.apk");
      await calculateFingerprintHash(calculateProps("android"), {});
      fs.utimesSync(
        apk,
        new Date(wallTimeMs + 1_000),
        new Date(wallTimeMs + 1_000)
      );
      wallTimeMs += 2_000;
      await uploadBuildCache(
        uploadProps("android", "expired-context", apk),
        {}
      );

      const insight = readInsight(entryDirectory("android", "expired-context"));
      expect(insight?.artifactReadyEstimate?.method).toBe("artifact-mtime-v1");
      expect(insight?.artifactReadyEstimate?.durationMs).toBe(1_000);
    } finally {
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH;
      dateNow.mockRestore();
    }
  });

  it("bounds abandoned calculation contexts in a long-lived host", async () => {
    installFakeFingerprintEngine("bounded-context");
    let wallTimeMs = Date.now();
    const dateNow = spyOn(Date, "now").mockImplementation(() => wallTimeMs);
    try {
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "bounded-context";
      for (let index = 0; index <= 128; index += 1) {
        await calculateFingerprintHash(
          calculateProps("android", projectRoot, {
            variant: `bounded-${index}`,
          }),
          {}
        );
        wallTimeMs += 1;
      }

      await uploadBuildCache(
        uploadProps(
          "android",
          "bounded-context",
          makeApk("bounded-context.apk"),
          projectRoot,
          { variant: "bounded-0" }
        ),
        {}
      );
      expect(
        readInsight(entryDirectory("android", "bounded-context"))
      ).toBeNull();

      // Move beyond the lifecycle TTL so this test leaves no abandoned state.
      wallTimeMs += 30 * 60 * 1000 + 1;
      await calculateFingerprintHash(
        calculateProps("android", projectRoot, { variant: "cleanup" }),
        {}
      );
      await uploadBuildCache(
        uploadProps(
          "android",
          "bounded-context",
          makeApk("bounded-cleanup.apk"),
          projectRoot,
          { variant: "cleanup" }
        ),
        {}
      );
    } finally {
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH;
      dateNow.mockRestore();
    }
  });

  it("does not correlate timing when the post-build fingerprint changed", async () => {
    installFakeFingerprintEngine("fallback");
    try {
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "before-build";
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST = "aaaa";
      await calculateFingerprintHash(calculateProps("android"), {});
      await resolveBuildCache(resolveProps("android", "before-build"), {});

      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "after-build";
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST = "bbbb";
      await calculateFingerprintHash(calculateProps("android"), {});
      await uploadBuildCache(
        uploadProps(
          "android",
          "after-build",
          makeApk("changed-post-build.apk")
        ),
        {}
      );

      const insight = readInsight(entryDirectory("android", "after-build"));
      expect(insight?.fingerprintHash).toBe("after-build");
      expect(insight?.artifactReadyEstimate).toBeUndefined();
      expect(fs.existsSync(entryDirectory("android", "before-build"))).toBe(
        false
      );
    } finally {
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH;
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST;
    }
  });

  it("does not cross-correlate two unresolved builds with the same identity", async () => {
    installFakeFingerprintEngine("ambiguous-context");
    try {
      process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH = "ambiguous-context";
      await calculateFingerprintHash(calculateProps("android"), {});
      await Promise.all([
        resolveBuildCache(resolveProps("android", "ambiguous-context"), {}),
        resolveBuildCache(resolveProps("android", "ambiguous-context"), {}),
      ]);

      await calculateFingerprintHash(calculateProps("android"), {});
      await uploadBuildCache(
        uploadProps(
          "android",
          "ambiguous-context",
          makeApk("ambiguous-context.apk")
        ),
        {}
      );

      const insight = readInsight(
        entryDirectory("android", "ambiguous-context")
      );
      expect(insight?.fingerprintHash).toBe("ambiguous-context");
      expect(insight?.artifactReadyEstimate).toBeUndefined();
    } finally {
      delete process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH;
    }
  });

  it("isolates fingerprints and platforms", async () => {
    await uploadBuildCache(
      uploadProps("android", "hash-one", makeApk("one.apk")),
      {}
    );

    expect(
      await resolveBuildCache(resolveProps("android", "hash-two"), {})
    ).toBeNull();
    expect(
      await resolveBuildCache(resolveProps("ios", "hash-one"), {})
    ).toBeNull();
  });

  it("reads valid legacy entries without migrating them", async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const legacy = path.join(cacheDir, "android_legacy.apk");
    fs.writeFileSync(legacy, "legacy");

    const resolved = await resolveBuildCache(
      resolveProps("android", "legacy"),
      {}
    );

    expect(resolved).toBe(legacy);
    expect(fs.existsSync(entryDirectory("android", "legacy"))).toBe(false);
  });

  it("requires a root Info.plist before accepting a legacy iOS bundle", async () => {
    const legacy = path.join(cacheDir, "ios_legacy-ios.app");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "binary"), "partial");

    expect(
      await resolveBuildCache(resolveProps("ios", "legacy-ios"), {})
    ).toBeNull();

    fs.writeFileSync(path.join(legacy, "Info.plist"), "<plist/>");
    expect(await resolveBuildCache(resolveProps("ios", "legacy-ios"), {})).toBe(
      legacy
    );
  });

  it("never lets an unsafe legacy fingerprint escape the cache directory", async () => {
    const outside = path.join(projectRoot, ".expo", "escaped.apk");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "outside");

    const resolved = await resolveBuildCache(
      resolveProps("android", "../escaped"),
      {}
    );

    expect(resolved).toBeNull();
  });
});
