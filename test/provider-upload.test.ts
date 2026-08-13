import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { removeAccessRecord, touchAccessRecord } from "../src/cache/access";
import * as cacheCleanup from "../src/cache/cleanup";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import { readManifest } from "../src/cache/manifest";
import { getCachePaths, getEntryId } from "../src/cache/paths";
import { uploadCacheEntry } from "../src/cache/store";
import { ensureLanState } from "../src/lan/state";
import * as lanSync from "../src/lan/sync";
import { createProviderFixture } from "./fixtures/provider-fixture";

const {
  projectRoot,
  cacheDir,
  resolveBuildCache,
  uploadBuildCache,
  resolveProps,
  uploadProps,
  makeApk,
  makeAppBundle,
  entryDirectory,
} = createProviderFixture();

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

  it("enforces maxEntries after an ordinary versioned cache hit", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-prune-"))
    );
    try {
      const oldFingerprint = "hit-prune-old";
      const hitFingerprint = "hit-prune-current";
      const oldArtifact = path.join(root, "old.apk");
      const hitArtifact = path.join(root, "current.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(hitArtifact, "current");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const oldEntryId = getEntryId("android", oldFingerprint);
      removeAccessRecord(paths.accessRoot, oldEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, oldEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });

      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 1,
          retentionDays: null,
        })
      ).toBe(hitCached);
      expect(fs.existsSync(oldCached!)).toBe(false);
      expect(fs.existsSync(hitCached!)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces maxSize after an ordinary versioned cache hit", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-size-"))
    );
    try {
      const oldFingerprint = "hit-size-old";
      const hitFingerprint = "hit-size-current";
      const oldArtifact = path.join(root, "large.apk");
      const hitArtifact = path.join(root, "small.apk");
      fs.writeFileSync(oldArtifact, Buffer.alloc(256 * 1024, 1));
      fs.writeFileSync(hitArtifact, "current");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const oldEntryId = getEntryId("android", oldFingerprint);
      removeAccessRecord(paths.accessRoot, oldEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, oldEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });

      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: "64KB",
          maxEntries: null,
          retentionDays: null,
        })
      ).toBe(hitCached);
      expect(fs.existsSync(oldCached!)).toBe(false);
      expect(fs.existsSync(hitCached!)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throttles repeated hit cleanup without delaying a stricter policy", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-throttle-"))
    );
    let wallTimeMs = Date.now();
    const dateNow = spyOn(Date, "now").mockImplementation(() => wallTimeMs);
    try {
      const oldFingerprint = "hit-throttle-old";
      const hitFingerprint = "hit-throttle-current";
      const oldArtifact = path.join(root, "old.apk");
      const hitArtifact = path.join(root, "current.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(hitArtifact, "current");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const ageEntry = (fingerprintHash: string): void => {
        const entryId = getEntryId("android", fingerprintHash);
        removeAccessRecord(paths.accessRoot, entryId, paths.providerRoot);
        touchAccessRecord(paths.accessRoot, entryId, "android", {
          now: new Date("2020-01-01T00:00:00.000Z"),
          leaseMs: 0,
          providerRoot: paths.providerRoot,
        });
      };

      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 2,
          retentionDays: null,
        })
      ).toBe(hitCached);
      ageEntry(oldFingerprint);

      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 1,
          retentionDays: null,
        })
      ).toBe(hitCached);
      expect(fs.existsSync(oldCached!)).toBe(false);

      const importedFingerprint = "hit-throttle-import-like";
      const importedArtifact = path.join(root, "imported.apk");
      fs.writeFileSync(importedArtifact, "imported");
      const importedCached = await uploadBuildCache(
        uploadProps("android", importedFingerprint, importedArtifact, root),
        { autoPrune: false }
      );
      ageEntry(importedFingerprint);

      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 1,
          retentionDays: null,
        })
      ).toBe(hitCached);
      expect(fs.existsSync(importedCached!)).toBe(true);

      wallTimeMs += 5 * 60 * 1000 + 1;
      expect(
        await resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 1,
          retentionDays: null,
        })
      ).toBe(hitCached);
      expect(fs.existsSync(importedCached!)).toBe(false);
    } finally {
      dateNow.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists the hit-cleanup throttle across provider processes", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-process-"))
    );
    try {
      const oldFingerprint = "hit-process-old";
      const hitFingerprint = "hit-process-current";
      const lateFingerprint = "hit-process-late";
      const oldArtifact = path.join(root, "old.apk");
      const hitArtifact = path.join(root, "current.apk");
      const lateArtifact = path.join(root, "late.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(hitArtifact, "current");
      fs.writeFileSync(lateArtifact, "late");
      await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const policy = {
        maxSize: null,
        maxEntries: 2,
        retentionDays: null,
      };
      expect(
        await resolveBuildCache(
          resolveProps("android", hitFingerprint, root),
          policy
        )
      ).toBe(hitCached);

      const lateCached = await uploadCacheEntry(
        {
          projectRoot: root,
          platform: "android",
          fingerprintHash: lateFingerprint,
        },
        lateArtifact
      );
      const paths = getCachePaths(root);
      const lateEntryId = getEntryId("android", lateFingerprint);
      removeAccessRecord(paths.accessRoot, lateEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, lateEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });

      const fixture = path.join(
        import.meta.dir,
        "fixtures",
        "provider-resolve.ts"
      );
      const child = Bun.spawn(
        [
          process.execPath,
          fixture,
          root,
          hitFingerprint,
          JSON.stringify(policy),
        ],
        { stdout: "ignore", stderr: "pipe" }
      );
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new Error(await new Response(child.stderr).text());
      }

      expect(fs.existsSync(lateCached!)).toBe(true);
      expect(fs.existsSync(hitCached!)).toBe(true);

      const markerPath = path.join(paths.stateRoot, "automatic-prune.json");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
        attemptedAt: string;
      };
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({
          ...marker,
          attemptedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })}\n`
      );
      const rollbackChild = Bun.spawn(
        [
          process.execPath,
          fixture,
          root,
          hitFingerprint,
          JSON.stringify(policy),
        ],
        { stdout: "ignore", stderr: "pipe" }
      );
      const rollbackExitCode = await rollbackChild.exited;
      if (rollbackExitCode !== 0) {
        throw new Error(await new Response(rollbackChild.stderr).text());
      }
      expect(fs.existsSync(lateCached!)).toBe(false);
      expect(fs.existsSync(hitCached!)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("forces cleanup after a LAN import inside the hit throttle window", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-lan-hit-prune-"))
    );
    let fetchSpy: ReturnType<typeof spyOn> | null = null;
    try {
      const oldFingerprint = "lan-hit-prune-old";
      const keeperFingerprint = "lan-hit-prune-keeper";
      const importedFingerprint = "lan-hit-prune-imported";
      const oldArtifact = path.join(root, "old.apk");
      const keeperArtifact = path.join(root, "keeper.apk");
      const importedArtifact = path.join(root, "imported.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(keeperArtifact, "keeper");
      fs.writeFileSync(importedArtifact, "imported");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const keeperCached = await uploadBuildCache(
        uploadProps("android", keeperFingerprint, keeperArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const oldEntryId = getEntryId("android", oldFingerprint);
      removeAccessRecord(paths.accessRoot, oldEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, oldEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });
      const policy = {
        maxSize: null,
        maxEntries: 2,
        retentionDays: null,
      };

      expect(
        await resolveBuildCache(
          resolveProps("android", keeperFingerprint, root),
          policy
        )
      ).toBe(keeperCached);
      await ensureLanState(paths.providerRoot);
      fetchSpy = spyOn(lanSync, "fetchLanEntryToLocal").mockImplementation(
        async (input) => {
          expect(input.entryId).toBe(
            getEntryId("android", importedFingerprint)
          );
          await uploadCacheEntry(
            {
              projectRoot: root,
              platform: "android",
              fingerprintHash: importedFingerprint,
            },
            importedArtifact
          );
          return { imported: true, peerId: null };
        }
      );

      const importedCached = await resolveBuildCache(
        resolveProps("android", importedFingerprint, root),
        { ...policy, lan: "read" }
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(importedCached).not.toBeNull();
      expect(fs.readFileSync(importedCached!, "utf8")).toBe("imported");
      expect(fs.existsSync(oldCached!)).toBe(false);
      expect(fs.existsSync(keeperCached!)).toBe(true);
      expect(fs.existsSync(importedCached!)).toBe(true);
    } finally {
      fetchSpy?.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the shared entry valid during concurrent same-key hit cleanup", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-concurrent-"))
    );
    try {
      const oldFingerprint = "hit-concurrent-old";
      const hitFingerprint = "hit-concurrent-current";
      const oldArtifact = path.join(root, "old.apk");
      const hitArtifact = path.join(root, "current.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(hitArtifact, "current");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const oldEntryId = getEntryId("android", oldFingerprint);
      removeAccessRecord(paths.accessRoot, oldEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, oldEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });
      const resolve = () =>
        resolveBuildCache(resolveProps("android", hitFingerprint, root), {
          maxSize: null,
          maxEntries: 1,
          retentionDays: null,
        });

      expect(await Promise.all([resolve(), resolve()])).toEqual([
        hitCached,
        hitCached,
      ]);
      expect(fs.existsSync(oldCached!)).toBe(false);
      expect(fs.existsSync(hitCached!)).toBe(true);
      expect(fs.readFileSync(hitCached!, "utf8")).toBe("current");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries ordinary hit cleanup immediately after a transient failure", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-cache-hit-retry-"))
    );
    let pruneSpy: ReturnType<typeof spyOn> | null = null;
    try {
      const oldFingerprint = "hit-retry-old";
      const hitFingerprint = "hit-retry-current";
      const oldArtifact = path.join(root, "old.apk");
      const hitArtifact = path.join(root, "current.apk");
      fs.writeFileSync(oldArtifact, "old");
      fs.writeFileSync(hitArtifact, "current");
      const oldCached = await uploadBuildCache(
        uploadProps("android", oldFingerprint, oldArtifact, root),
        { autoPrune: false }
      );
      const hitCached = await uploadBuildCache(
        uploadProps("android", hitFingerprint, hitArtifact, root),
        { autoPrune: false }
      );
      const paths = getCachePaths(root);
      const oldEntryId = getEntryId("android", oldFingerprint);
      removeAccessRecord(paths.accessRoot, oldEntryId, paths.providerRoot);
      touchAccessRecord(paths.accessRoot, oldEntryId, "android", {
        now: new Date("2020-01-01T00:00:00.000Z"),
        leaseMs: 0,
        providerRoot: paths.providerRoot,
      });
      const realPrune = cacheCleanup.pruneCache;
      let calls = 0;
      pruneSpy = spyOn(cacheCleanup, "pruneCache").mockImplementation(
        async (...args: Parameters<typeof cacheCleanup.pruneCache>) => {
          calls += 1;
          if (calls === 1) {
            throw new Error("transient cleanup failure");
          }
          return realPrune(...args);
        }
      );
      const policy = {
        maxSize: null,
        maxEntries: 1,
        retentionDays: null,
      };

      expect(
        await resolveBuildCache(
          resolveProps("android", hitFingerprint, root),
          policy
        )
      ).toBe(hitCached);
      expect(fs.existsSync(oldCached!)).toBe(true);
      expect(
        await resolveBuildCache(
          resolveProps("android", hitFingerprint, root),
          policy
        )
      ).toBe(hitCached);
      expect(calls).toBe(2);
      expect(fs.existsSync(oldCached!)).toBe(false);
      expect(fs.existsSync(hitCached!)).toBe(true);
    } finally {
      pruneSpy?.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("keeps a versioned hit when automatic cleanup options are invalid", async () => {
    const fingerprint = "invalid-hit-cleanup-options";
    const cached = await uploadBuildCache(
      uploadProps("android", fingerprint, makeApk("invalid-hit-cleanup.apk")),
      { autoPrune: false }
    );

    expect(
      await resolveBuildCache(resolveProps("android", fingerprint), {
        maxSize: "not-a-size",
      })
    ).toBe(cached);
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
