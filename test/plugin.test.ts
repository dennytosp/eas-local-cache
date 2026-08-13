import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
  CalculateFingerprintHashProps,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import plugin from "../src/index";
import { removeAccessRecord, touchAccessRecord } from "../src/cache/access";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import { readManifest } from "../src/cache/manifest";
import { readInsight } from "../src/cache/insight";
import { scanResolveEvents } from "../src/cache/events";
import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
} from "../src/cache/paths";

const projectRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-"))
);
const cacheDir = path.join(projectRoot, ".expo", "cache");

if (
  typeof plugin.calculateFingerprintHash !== "function" ||
  !("resolveBuildCache" in plugin) ||
  !("uploadBuildCache" in plugin)
) {
  throw new Error(
    "Plugin must implement calculateFingerprintHash/resolveBuildCache/uploadBuildCache"
  );
}

const {
  calculateFingerprintHash: calculateFingerprintHashCallback,
  resolveBuildCache,
  uploadBuildCache,
} = plugin;

const calculateFingerprintHash = (
  props: CalculateFingerprintHashProps,
  _options: Record<string, unknown> = {}
) => calculateFingerprintHashCallback(props, { toolchain: "off" });

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const resolveProps = (
  platform: "ios" | "android",
  fingerprintHash: string,
  root = projectRoot,
  runOptions: ResolveBuildCacheProps["runOptions"] = {}
): ResolveBuildCacheProps =>
  ({
    projectRoot: root,
    platform,
    fingerprintHash,
    runOptions,
  } as ResolveBuildCacheProps);

const uploadProps = (
  platform: "ios" | "android",
  fingerprintHash: string,
  buildPath: string,
  root = projectRoot,
  runOptions: UploadBuildCacheProps["runOptions"] = {}
): UploadBuildCacheProps =>
  ({
    projectRoot: root,
    platform,
    fingerprintHash,
    buildPath,
    runOptions,
  } as UploadBuildCacheProps);

const calculateProps = (
  platform: "ios" | "android",
  root = projectRoot,
  runOptions: CalculateFingerprintHashProps["runOptions"] = platform === "ios"
    ? { configuration: "Debug" }
    : {}
): CalculateFingerprintHashProps => ({
  projectRoot: root,
  platform,
  runOptions,
});

const installFakeFingerprintEngine = (hash: string) => {
  const packageRoot = path.join(
    projectRoot,
    "node_modules",
    "@expo",
    "fingerprint"
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@expo/fingerprint",
      version: "0.20.7-test",
      main: "index.js",
    })
  );
  fs.writeFileSync(
    path.join(packageRoot, "index.js"),
    `exports.createFingerprintAsync = async () => ({
      hash: process.env.EAS_LOCAL_CACHE_TEST_UNIT_HASH || ${JSON.stringify(
        hash
      )},
      sources: [{
        type: "contents",
        id: "expoConfig",
        hash: process.env.EAS_LOCAL_CACHE_TEST_UNIT_DIGEST || "abc123",
        reasons: ["expoConfig"],
        contents: "must-not-persist",
      }],
    });\n`
  );
};

const makeApk = (name: string, contents = "not-really-an-apk") => {
  const apk = path.join(projectRoot, name);
  fs.writeFileSync(apk, contents);
  return apk;
};

const makeAppBundle = (name: string, marker = "v1") => {
  const app = path.join(projectRoot, name);
  fs.mkdirSync(path.join(app, "Frameworks", "Example.framework"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(app, "Info.plist"), "<plist/>");
  fs.writeFileSync(path.join(app, "binary"), marker, { mode: 0o755 });
  fs.writeFileSync(
    path.join(app, "Frameworks", "Example.framework", "Example"),
    "framework",
    { mode: 0o755 }
  );
  fs.symlinkSync(
    "Example",
    path.join(app, "Frameworks", "Example.framework", "Current")
  );
  return app;
};

const entryDirectory = (
  platform: "ios" | "android",
  fingerprintHash: string,
  root = projectRoot
) =>
  getEntryDirectory(
    getCachePaths(root),
    platform,
    getEntryId(platform, fingerprintHash)
  );

describe("provider resolution", () => {
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

describe("versioned uploads", () => {
  it("publishes an Android artifact and immutable manifest", async () => {
    const source = makeApk("app-release.apk");
    const cached = await uploadBuildCache(
      uploadProps("android", "abc123", source),
      {}
    );

    const expectedEntry = entryDirectory("android", "abc123");
    expect(cached).toBe(path.join(expectedEntry, "artifact.apk"));
    expect(fs.readFileSync(cached!, "utf8")).toBe("not-really-an-apk");

    const manifest = readManifest(expectedEntry);
    expect(manifest.platform).toBe("android");
    expect(manifest.fingerprintHash).toBe("abc123");
    expect(manifest.entryId).toBe(getEntryId("android", "abc123"));
    expect(manifest.artifact.type).toBe("file");
    expect(manifest.artifact.integrity.algorithm).toBe("sha256");
    expect(manifest.artifact.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("publishes and restores a complete iOS app bundle", async () => {
    const cached = await uploadBuildCache(
      uploadProps("ios", "ios-hash", makeAppBundle("Example.app")),
      {}
    );

    expect(cached).toBe(
      path.join(entryDirectory("ios", "ios-hash"), "artifact.app")
    );
    expect(fs.readFileSync(path.join(cached!, "Info.plist"), "utf8")).toBe(
      "<plist/>"
    );
    expect(
      fs
        .lstatSync(
          path.join(cached!, "Frameworks", "Example.framework", "Current")
        )
        .isSymbolicLink()
    ).toBe(true);
    expect(await resolveBuildCache(resolveProps("ios", "ios-hash"), {})).toBe(
      cached
    );
  });

  it("keeps the first valid artifact for an immutable fingerprint", async () => {
    const first = await uploadBuildCache(
      uploadProps("android", "same", makeApk("first.apk", "first")),
      {}
    );
    const second = await uploadBuildCache(
      uploadProps("android", "same", makeApk("second.apk", "second")),
      {}
    );

    expect(second).toBe(first);
    expect(fs.readFileSync(first!, "utf8")).toBe("first");
  });

  it("allows concurrent writers to converge on one complete entry", async () => {
    const [first, second] = await Promise.all([
      uploadBuildCache(
        uploadProps("android", "concurrent", makeApk("a.apk", "one")),
        {}
      ),
      uploadBuildCache(
        uploadProps("android", "concurrent", makeApk("b.apk", "two")),
        {}
      ),
    ]);

    expect(first).toBe(second);
    expect(["one", "two"]).toContain(fs.readFileSync(first!, "utf8"));
    expect(
      await resolveBuildCache(resolveProps("android", "concurrent"), {})
    ).toBe(first);
  });

  it("cleans staging and releases the lock when validation fails", async () => {
    const invalidApp = path.join(projectRoot, "Invalid.app");
    fs.mkdirSync(invalidApp, { recursive: true });
    fs.writeFileSync(path.join(invalidApp, "binary"), "binary");

    const result = await uploadBuildCache(
      uploadProps("ios", "invalid", invalidApp),
      {}
    );
    const paths = getCachePaths(projectRoot);

    expect(result).toBeNull();
    expect(fs.existsSync(entryDirectory("ios", "invalid"))).toBe(false);
    expect(
      fs.existsSync(paths.stagingRoot) ? fs.readdirSync(paths.stagingRoot) : []
    ).toEqual([]);
    expect(fs.readdirSync(paths.locksRoot)).toEqual([]);
  });

  it("rejects a directory passed as an Android artifact", async () => {
    const directory = path.join(projectRoot, "not-an-apk");
    fs.mkdirSync(directory, { recursive: true });

    expect(
      await uploadBuildCache(uploadProps("android", "directory", directory), {})
    ).toBeNull();
  });

  it("does not create cache directories through a symlinked provider parent", async () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-upload-outside-"))
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.symlinkSync(outside, path.join(cacheDir, "eas-local-cache"));

    try {
      expect(
        await uploadBuildCache(
          uploadProps(
            "android",
            "provider-upload-symlink",
            makeApk("provider-symlink.apk")
          ),
          {}
        )
      ).toBeNull();
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("automatically prunes the least recently used entry after upload", async () => {
    const firstFingerprint = "auto-prune-first";
    const first = await uploadBuildCache(
      uploadProps(
        "android",
        firstFingerprint,
        makeApk("auto-first.apk", "first")
      ),
      { maxSize: null, maxEntries: 1, retentionDays: null }
    );
    const paths = getCachePaths(projectRoot);
    const firstEntryId = getEntryId("android", firstFingerprint);
    removeAccessRecord(paths.accessRoot, firstEntryId, paths.providerRoot);
    touchAccessRecord(paths.accessRoot, firstEntryId, "android", {
      now: new Date("2020-01-01T00:00:00.000Z"),
      leaseMs: 0,
      providerRoot: paths.providerRoot,
    });

    const second = await uploadBuildCache(
      uploadProps(
        "android",
        "auto-prune-second",
        makeApk("auto-second.apk", "second")
      ),
      { maxSize: null, maxEntries: 1, retentionDays: null }
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(fs.existsSync(first!)).toBe(false);
    expect(fs.existsSync(second!)).toBe(true);
  });

  it("keeps a successful upload when cleanup options are invalid", async () => {
    const cached = await uploadBuildCache(
      uploadProps(
        "android",
        "invalid-cleanup-options",
        makeApk("invalid-cleanup.apk")
      ),
      { maxSize: "not-a-size" }
    );

    expect(cached).not.toBeNull();
    expect(fs.existsSync(cached!)).toBe(true);
  });

  it("does not return an artifact while its entry is locked for maintenance", async () => {
    const fingerprint = "resolve-lock";
    const cached = await uploadBuildCache(
      uploadProps("android", fingerprint, makeApk("resolve-lock.apk")),
      {}
    );
    const paths = getCachePaths(projectRoot);
    const lock = await acquireEntryLock(
      paths.locksRoot,
      getEntryId("android", fingerprint)
    );

    expect(lock).not.toBeNull();
    try {
      expect(
        await resolveBuildCache(resolveProps("android", fingerprint), {})
      ).toBeNull();
      expect(fs.existsSync(cached!)).toBe(true);
    } finally {
      releaseEntryLock(lock!);
    }

    expect(
      await resolveBuildCache(resolveProps("android", fingerprint), {})
    ).toBe(cached);
  });
});

describe("self-healing resolution", () => {
  it("quarantines an Android entry whose bytes changed", async () => {
    const cached = await uploadBuildCache(
      uploadProps("android", "corrupt", makeApk("corrupt.apk")),
      {}
    );
    fs.appendFileSync(cached!, "tampered");

    const resolved = await resolveBuildCache(
      resolveProps("android", "corrupt"),
      {}
    );
    const paths = getCachePaths(projectRoot);

    expect(resolved).toBeNull();
    expect(fs.existsSync(entryDirectory("android", "corrupt"))).toBe(false);
    const quarantines = fs
      .readdirSync(paths.quarantineRoot)
      .filter((name) => !name.endsWith(".json"));
    expect(quarantines).toHaveLength(1);
    expect(
      fs.existsSync(path.join(paths.quarantineRoot, `${quarantines[0]}.json`))
    ).toBe(true);
  });

  it("quarantines an iOS entry whose nested content changed", async () => {
    const cached = await uploadBuildCache(
      uploadProps("ios", "corrupt-ios", makeAppBundle("Corrupt.app")),
      {}
    );
    fs.writeFileSync(path.join(cached!, "binary"), "different");

    expect(
      await resolveBuildCache(resolveProps("ios", "corrupt-ios"), {})
    ).toBeNull();
  });

  it("rejects an iOS bundle symlink that escapes the cached artifact", async () => {
    const cached = await uploadBuildCache(
      uploadProps("ios", "escaping-link", makeAppBundle("Escaping.app")),
      {}
    );
    const link = path.join(
      cached!,
      "Frameworks",
      "Example.framework",
      "Current"
    );
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(projectRoot, "outside-framework"), link);

    expect(
      await resolveBuildCache(resolveProps("ios", "escaping-link"), {})
    ).toBeNull();
    expect(fs.existsSync(entryDirectory("ios", "escaping-link"))).toBe(false);
  });

  it("quarantines an entry symlink without writing through it", async () => {
    const fingerprint = "entry-symlink";
    const entry = entryDirectory("android", fingerprint);
    const outside = path.join(projectRoot, "outside-cache-entry");
    const sentinel = path.join(outside, "quarantine.json");
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(sentinel, "do-not-change");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.symlinkSync(outside, entry);

    expect(
      await resolveBuildCache(resolveProps("android", fingerprint), {})
    ).toBeNull();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("do-not-change");
    expect(fs.existsSync(entry)).toBe(false);

    const quarantineRoot = getCachePaths(projectRoot).quarantineRoot;
    const quarantined = fs
      .readdirSync(quarantineRoot)
      .find((name) => !name.endsWith(".json"));
    expect(quarantined).toBeDefined();
    expect(
      fs.lstatSync(path.join(quarantineRoot, quarantined!)).isSymbolicLink()
    ).toBe(true);
    expect(
      fs.existsSync(path.join(quarantineRoot, `${quarantined}.json`))
    ).toBe(true);
  });

  it("does not follow a cache platform directory outside the provider root", async () => {
    const fingerprint = "platform-symlink";
    const paths = getCachePaths(projectRoot);
    const outsidePlatform = path.join(projectRoot, "outside-platform");
    const outsideEntry = path.join(
      outsidePlatform,
      getEntryId("android", fingerprint)
    );
    fs.rmSync(outsidePlatform, { recursive: true, force: true });
    fs.mkdirSync(outsideEntry, { recursive: true });
    fs.writeFileSync(path.join(outsideEntry, "sentinel"), "do-not-move");
    fs.mkdirSync(paths.entriesRoot, { recursive: true });
    fs.symlinkSync(outsidePlatform, path.join(paths.entriesRoot, "android"));

    expect(
      await resolveBuildCache(resolveProps("android", fingerprint), {})
    ).toBeNull();
    expect(fs.readFileSync(path.join(outsideEntry, "sentinel"), "utf8")).toBe(
      "do-not-move"
    );
  });

  it("does not follow the provider root outside the project", async () => {
    const fingerprint = "provider-root-symlink";
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-outside-"))
    );
    const providerParent = path.join(cacheDir, "eas-local-cache");
    const outsideProvider = path.join(outside, "v1");
    const outsideEntry = path.join(
      outsideProvider,
      "entries",
      "android",
      getEntryId("android", fingerprint)
    );
    fs.mkdirSync(outsideEntry, { recursive: true });
    fs.writeFileSync(path.join(outsideEntry, "sentinel"), "do-not-move");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.symlinkSync(outside, providerParent);

    try {
      expect(
        await resolveBuildCache(resolveProps("android", fingerprint), {})
      ).toBeNull();
      expect(fs.readFileSync(path.join(outsideEntry, "sentinel"), "utf8")).toBe(
        "do-not-move"
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores incomplete staging directories", async () => {
    const paths = getCachePaths(projectRoot);
    fs.mkdirSync(path.join(paths.stagingRoot, "partial", "artifact.app"), {
      recursive: true,
    });

    expect(
      await resolveBuildCache(resolveProps("ios", "partial"), {})
    ).toBeNull();
    expect(fs.existsSync(path.join(paths.stagingRoot, "partial"))).toBe(true);
  });

  it("quarantines malformed manifests instead of returning their artifact", async () => {
    const cached = await uploadBuildCache(
      uploadProps("android", "manifest", makeApk("manifest.apk")),
      {}
    );
    fs.writeFileSync(
      path.join(path.dirname(cached!), "manifest.json"),
      '{"schemaVersion":99}\n'
    );

    expect(
      await resolveBuildCache(resolveProps("android", "manifest"), {})
    ).toBeNull();
    expect(fs.existsSync(path.dirname(cached!))).toBe(false);
  });

  it("does not follow a symlinked manifest outside the cache entry", async () => {
    const cached = await uploadBuildCache(
      uploadProps("android", "manifest-link", makeApk("manifest-link.apk")),
      {}
    );
    const entry = path.dirname(cached!);
    const manifestPath = path.join(entry, "manifest.json");
    const outsideManifest = path.join(projectRoot, "outside-manifest.json");
    const outsideContents = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(outsideManifest, outsideContents);
    fs.unlinkSync(manifestPath);
    fs.symlinkSync(outsideManifest, manifestPath);

    expect(
      await resolveBuildCache(resolveProps("android", "manifest-link"), {})
    ).toBeNull();
    expect(fs.readFileSync(outsideManifest, "utf8")).toBe(outsideContents);
    expect(fs.existsSync(entry)).toBe(false);
  });
});

describe("project roots", () => {
  it("uses Expo's projectRoot rather than the current directory", async () => {
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-other-"))
    );
    const buildPath = path.join(otherRoot, "Other.apk");
    fs.writeFileSync(buildPath, "other");

    try {
      const cached = await uploadBuildCache(
        uploadProps("android", "elsewhere", buildPath, otherRoot),
        {}
      );

      expect(cached).toBe(
        path.join(
          entryDirectory("android", "elsewhere", otherRoot),
          "artifact.apk"
        )
      );
      expect(fs.existsSync(cached!)).toBe(true);
      expect(fs.existsSync(entryDirectory("android", "elsewhere"))).toBe(false);
      expect(
        await resolveBuildCache(
          resolveProps("android", "elsewhere", otherRoot),
          {}
        )
      ).toBe(cached);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
