import { afterAll, beforeEach } from "bun:test";
import type {
  CalculateFingerprintHashProps,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import plugin from "../../src/index";
import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
} from "../../src/cache/paths";

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

export const createProviderFixture = () => {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-"))
  );
  const cacheDir = path.join(projectRoot, ".expo", "cache");

  afterAll(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  beforeEach(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  const calculateFingerprintHash = (
    props: CalculateFingerprintHashProps,
    _options: Record<string, unknown> = {}
  ) => calculateFingerprintHashCallback(props, { toolchain: "off" });
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

  return {
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
  };
};
