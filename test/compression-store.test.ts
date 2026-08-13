import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { inventoryCache } from "../src/cache/catalog";
import { readManifest } from "../src/cache/manifest";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
  getRestoreDirectory,
} from "../src/cache/paths";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
} from "../src/cache/store";
import { discoverZstdCodec } from "../src/cache/zstd";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-compressed-store-"))
  );
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

const makeApp = (): string => {
  const app = path.join(projectRoot, "Fixture.app");
  fs.mkdirSync(path.join(app, "Frameworks", "Example.framework"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(app, "Info.plist"), "<plist/>".repeat(1_024));
  fs.writeFileSync(path.join(app, "binary"), "native-binary".repeat(100_000), {
    mode: 0o755,
  });
  fs.symlinkSync(
    "../../binary",
    path.join(app, "Frameworks", "Example.framework", "Current")
  );
  return app;
};

describe("compressed cache store", () => {
  it("publishes and atomically restores a compressed Android artifact", async () => {
    if (!discoverZstdCodec()) return;
    const apk = path.join(projectRoot, "fixture.apk");
    fs.writeFileSync(apk, "compressible-apk".repeat(100_000));
    const fingerprintHash = "compressed-android";
    const stored = await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );
    expect(stored).toEndWith("artifact.apk.zst");

    const paths = getCachePaths(projectRoot);
    const entryId = getEntryId("android", fingerprintHash);
    const entry = getEntryDirectory(paths, "android", entryId);
    const manifest = readManifest(entry);
    expect(manifest.schemaVersion).toBe(2);
    expect(fs.existsSync(path.join(entry, "artifact.apk"))).toBe(false);

    const resolved = await resolveCacheEntryDetailed({
      projectRoot,
      platform: "android",
      fingerprintHash,
    });
    expect(resolved.outcome).toBe("hit");
    if (resolved.outcome !== "hit") throw new Error("expected hit");
    expect(fs.readFileSync(resolved.path)).toEqual(fs.readFileSync(apk));
    expect(resolved.entryDirectory).toBe(entry);
    expect(resolved.path).toStartWith(
      getRestoreDirectory(paths, "android", entryId)
    );

    const catalog = inventoryCache(projectRoot);
    expect(catalog.entries[0]).toMatchObject({
      encoding: "zstd",
      logicalArtifactBytes: fs.lstatSync(apk).size,
    });
    expect(catalog.usage.restoreCommittedBytes).toBeGreaterThan(0);
  });

  it("round-trips an iOS app and rematerializes after its restore is removed", async () => {
    if (!discoverZstdCodec()) return;
    const app = makeApp();
    const fingerprintHash = "compressed-ios";
    await uploadCacheEntry(
      { projectRoot, platform: "ios", fingerprintHash },
      app,
      { compressionMode: "zstd" }
    );
    const paths = getCachePaths(projectRoot);
    const entryId = getEntryId("ios", fingerprintHash);
    const entry = getEntryDirectory(paths, "ios", entryId);
    expect(readManifest(entry).schemaVersion).toBe(2);

    const first = await resolveCacheEntryDetailed({
      projectRoot,
      platform: "ios",
      fingerprintHash,
    });
    expect(first.outcome).toBe("hit");
    const restore = getRestoreDirectory(paths, "ios", entryId);
    fs.rmSync(restore, { recursive: true, force: true });
    const second = await resolveCacheEntryDetailed({
      projectRoot,
      platform: "ios",
      fingerprintHash,
    });
    expect(second.outcome).toBe("hit");
    if (second.outcome !== "hit") throw new Error("expected hit");
    expect(fs.statSync(path.join(second.path, "binary")).mode & 0o777).toBe(
      0o755
    );
    expect(
      fs.readlinkSync(
        path.join(second.path, "Frameworks", "Example.framework", "Current")
      )
    ).toBe("../../binary");
  });

  it("falls back to schema 1 when zstd is unavailable", async () => {
    const apk = path.join(projectRoot, "fallback.apk");
    fs.writeFileSync(apk, "fallback".repeat(10_000));
    const fingerprintHash = "fallback";
    const stored = await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd", codec: null }
    );
    expect(stored).toEndWith("artifact.apk");
    const entry = getEntryDirectory(
      getCachePaths(projectRoot),
      "android",
      getEntryId("android", fingerprintHash)
    );
    expect(readManifest(entry).schemaVersion).toBe(1);
  });

  it("quarantines a compressed entry whose payload was corrupted", async () => {
    if (!discoverZstdCodec()) return;
    const apk = path.join(projectRoot, "corrupt.apk");
    fs.writeFileSync(apk, "corruptible".repeat(100_000));
    const fingerprintHash = "corrupt-compressed";
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );

    const paths = getCachePaths(projectRoot);
    const entryId = getEntryId("android", fingerprintHash);
    const entry = getEntryDirectory(paths, "android", entryId);
    const manifest = readManifest(entry);
    if (manifest.schemaVersion !== 2) throw new Error("expected compression");
    expect(
      (
        await resolveCacheEntryDetailed({
          projectRoot,
          platform: "android",
          fingerprintHash,
        })
      ).outcome
    ).toBe("hit");
    const restore = getRestoreDirectory(paths, "android", entryId);
    expect(fs.existsSync(restore)).toBe(true);
    fs.appendFileSync(
      path.join(entry, manifest.payload.relativePath),
      "damage"
    );

    expect(
      await resolveCacheEntryDetailed({
        projectRoot,
        platform: "android",
        fingerprintHash,
      })
    ).toEqual({ outcome: "miss", reason: "corrupt" });
    expect(fs.existsSync(entry)).toBe(false);
    expect(fs.existsSync(restore)).toBe(false);
    expect(
      fs
        .readdirSync(paths.quarantineRoot)
        .some((name) => name.endsWith("-restore"))
    ).toBe(true);
  });

  it("replaces an unreadable compressed entry with the new schema 1 build", async () => {
    if (!discoverZstdCodec()) return;
    const apk = path.join(projectRoot, "replacement.apk");
    fs.writeFileSync(apk, "old-compressed-build".repeat(100_000));
    const fingerprintHash = "decoder-replacement";
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );

    const paths = getCachePaths(projectRoot);
    const entryId = getEntryId("android", fingerprintHash);
    const compressedManifest = readManifest(
      getEntryDirectory(paths, "android", entryId)
    );
    if (compressedManifest.schemaVersion !== 2) {
      throw new Error("expected compression");
    }
    const restore = getRestoreDirectory(paths, "android", entryId);
    fs.rmSync(restore, { recursive: true, force: true });
    expect(
      await resolveCacheEntryDetailed({
        projectRoot,
        platform: "android",
        fingerprintHash,
        codec: null,
      })
    ).toEqual({
      outcome: "miss",
      reason: "compression-unavailable",
      compressedPayloadDigest: compressedManifest.payload.integrity.digest,
    });

    fs.writeFileSync(apk, "new-uncompressed-build".repeat(100_000));
    const stored = await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      {
        compressionMode: "zstd",
        replaceCompressedUnavailable: true,
        replaceCompressedPayloadDigest:
          compressedManifest.payload.integrity.digest,
      }
    );
    expect(stored).toEndWith("artifact.apk");
    const entry = getEntryDirectory(paths, "android", entryId);
    expect(readManifest(entry).schemaVersion).toBe(1);
    expect(fs.existsSync(restore)).toBe(false);
    expect(fs.readFileSync(path.join(entry, "artifact.apk"))).toEqual(
      fs.readFileSync(apk)
    );
  });

  it("does not replace a newer compressed generation after a stale miss", async () => {
    if (!discoverZstdCodec()) return;
    const apk = path.join(projectRoot, "generation.apk");
    const fingerprintHash = "generation-race";
    fs.writeFileSync(apk, "first-generation".repeat(100_000));
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );
    const paths = getCachePaths(projectRoot);
    const entry = getEntryDirectory(
      paths,
      "android",
      getEntryId("android", fingerprintHash)
    );
    const first = readManifest(entry);
    if (first.schemaVersion !== 2) throw new Error("expected compression");

    fs.rmSync(entry, { recursive: true, force: true });
    fs.writeFileSync(apk, "second-generation".repeat(100_000));
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );
    const second = readManifest(entry);
    if (second.schemaVersion !== 2) throw new Error("expected compression");
    expect(second.payload.integrity.digest).not.toBe(
      first.payload.integrity.digest
    );

    fs.writeFileSync(apk, "stale-rebuild".repeat(100_000));
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      {
        compressionMode: "zstd",
        replaceCompressedUnavailable: true,
        replaceCompressedPayloadDigest: first.payload.integrity.digest,
      }
    );
    expect(readManifest(entry)).toEqual(second);
  });

  it("waits for an in-progress compressed restore instead of rebuilding", async () => {
    if (!discoverZstdCodec()) return;
    const apk = path.join(projectRoot, "restore-wait.apk");
    fs.writeFileSync(apk, "restore-wait".repeat(100_000));
    const fingerprintHash = "restore-wait";
    await uploadCacheEntry(
      { projectRoot, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );
    const paths = getCachePaths(projectRoot);
    const entryId = getEntryId("android", fingerprintHash);
    const lock = await acquireEntryLock(paths.locksRoot, entryId);
    if (!lock) throw new Error("expected lock");
    const resolution = resolveCacheEntryDetailed({
      projectRoot,
      platform: "android",
      fingerprintHash,
    });
    setTimeout(() => releaseEntryLock(lock), 400);
    const result = await resolution;
    expect(result.outcome).toBe("hit");
    expect(fs.existsSync(getRestoreDirectory(paths, "android", entryId))).toBe(
      true
    );
  });
});
