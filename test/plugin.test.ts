import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type {
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The plugin resolves its cache directory from `process.cwd()` at module load
 * time, so we move into a throwaway project root *before* importing it.
 */
const originalCwd = process.cwd();
// realpath: on macOS os.tmpdir() is the /var -> /private/var symlink, and the
// plugin reports the resolved path, so comparisons would otherwise disagree.
const projectRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-"))
);
process.chdir(projectRoot);

const cacheDir = path.join(projectRoot, ".expo/cache");

const mod = await import("../src/index");
const plugin = mod.default;

if (!("resolveBuildCache" in plugin) || !("uploadBuildCache" in plugin)) {
  throw new Error("Plugin must implement resolveBuildCache/uploadBuildCache");
}

const { resolveBuildCache, uploadBuildCache } = plugin;

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const resolveProps = (
  platform: "ios" | "android",
  fingerprintHash: string
): ResolveBuildCacheProps =>
  ({ projectRoot, platform, fingerprintHash } as ResolveBuildCacheProps);

const uploadProps = (
  platform: "ios" | "android",
  fingerprintHash: string,
  buildPath: string
): UploadBuildCacheProps =>
  ({
    projectRoot,
    platform,
    fingerprintHash,
    buildPath,
  } as UploadBuildCacheProps);

/** Creates a fake .apk on disk and returns its path. */
const makeApk = (name: string) => {
  const apk = path.join(projectRoot, name);
  fs.writeFileSync(apk, "not-really-an-apk");
  return apk;
};

/** Creates a fake .app bundle (a directory) on disk and returns its path. */
const makeAppBundle = (name: string) => {
  const app = path.join(projectRoot, name);
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist/>");
  return app;
};

describe("resolveBuildCache", () => {
  it("returns null when nothing has been cached", async () => {
    const result = await resolveBuildCache(resolveProps("android", "abc123"), {});
    expect(result).toBeNull();
  });

  it("creates the cache directory as a side effect of looking up", async () => {
    await resolveBuildCache(resolveProps("android", "abc123"), {});
    expect(fs.existsSync(cacheDir)).toBe(true);
  });

  it("does not match a different fingerprint", async () => {
    await uploadBuildCache(
      uploadProps("android", "hash-one", makeApk("one.apk")),
      {}
    );

    const result = await resolveBuildCache(
      resolveProps("android", "hash-two"),
      {}
    );
    expect(result).toBeNull();
  });

  it("does not match the same fingerprint on a different platform", async () => {
    await uploadBuildCache(
      uploadProps("android", "shared-hash", makeApk("shared.apk")),
      {}
    );

    const result = await resolveBuildCache(
      resolveProps("ios", "shared-hash"),
      {}
    );
    expect(result).toBeNull();
  });

  it("rejects an iOS cache entry that is a file rather than an .app bundle", async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "ios_corrupt.app"), "not a bundle");

    const result = await resolveBuildCache(resolveProps("ios", "corrupt"), {});
    expect(result).toBeNull();
  });
});

describe("uploadBuildCache", () => {
  it("returns null when the build artifact does not exist", async () => {
    const result = await uploadBuildCache(
      uploadProps("android", "missing", path.join(projectRoot, "nope.apk")),
      {}
    );
    expect(result).toBeNull();
  });

  it("caches an Android .apk file and names it by platform and fingerprint", async () => {
    const cached = await uploadBuildCache(
      uploadProps("android", "abc123", makeApk("app-release.apk")),
      {}
    );

    expect(cached).toBe(path.join(cacheDir, "android_abc123.apk"));
    expect(fs.readFileSync(cached!, "utf8")).toBe("not-really-an-apk");
  });

  it("caches an iOS .app bundle as a directory, contents included", async () => {
    const cached = await uploadBuildCache(
      uploadProps("ios", "abc123", makeAppBundle("MyApp.app")),
      {}
    );

    expect(cached).toBe(path.join(cacheDir, "ios_abc123.app"));
    expect(fs.statSync(cached!).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(cached!, "Contents", "Info.plist"))).toBe(
      true
    );
  });

  it("overwrites a previously cached bundle for the same fingerprint", async () => {
    const first = makeAppBundle("First.app");
    await uploadBuildCache(uploadProps("ios", "same", first), {});

    const second = makeAppBundle("Second.app");
    fs.writeFileSync(path.join(second, "Contents", "marker"), "v2");
    const cached = await uploadBuildCache(uploadProps("ios", "same", second), {});

    expect(fs.existsSync(path.join(cached!, "Contents", "marker"))).toBe(true);
  });
});

describe("round trip", () => {
  it("a cached Android build is found again on the next resolve", async () => {
    const uploaded = await uploadBuildCache(
      uploadProps("android", "round-trip", makeApk("round-trip.apk")),
      {}
    );

    const resolved = await resolveBuildCache(
      resolveProps("android", "round-trip"),
      {}
    );

    expect(resolved).toBe(uploaded);
  });

  it("a cached iOS build is found again on the next resolve", async () => {
    const uploaded = await uploadBuildCache(
      uploadProps("ios", "round-trip", makeAppBundle("RoundTrip.app")),
      {}
    );

    const resolved = await resolveBuildCache(
      resolveProps("ios", "round-trip"),
      {}
    );

    expect(resolved).toBe(uploaded);
  });
});
