import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getCachePaths, getEntryId } from "../src/cache/paths";
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
