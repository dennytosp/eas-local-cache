import {
  BuildCacheProviderPlugin,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";
import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Local directory to store build cache files in project root
 */
const CACHE_DIR = path.join(process.cwd(), ".expo/cache");

/**
 * Ensures the cache directory exists
 */
const ensureCacheDir = () => {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return CACHE_DIR;
};

/**
 * Gets the cache file path for a specific build based on fingerprint and platform
 */
const getCacheFilePath = (fingerprintHash: string, platform: string) => {
  // For iOS, use .app extension, for Android use .apk
  const extension = platform === "ios" ? ".app" : ".apk";
  const filename = `${platform}_${fingerprintHash}${extension}`;
  return path.join(ensureCacheDir(), filename);
};

/**
 * Copy directories recursively using more reliable commands
 */
const copyDirectory = (source: string, destination: string): boolean => {
  try {
    // Make parent directory if it doesn't exist
    const destDir = path.dirname(destination);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // If destination already exists, remove it
    if (fs.existsSync(destination)) {
      if (fs.statSync(destination).isDirectory()) {
        fs.rmSync(destination, { recursive: true, force: true });
      } else {
        fs.unlinkSync(destination);
      }
    }

    // Try ditto first (perfect for macOS app bundles)
    const dittoResult = child_process.spawnSync(
      "ditto",
      [source, destination],
      {
        stdio: "inherit",
      }
    );

    if (dittoResult.status === 0) {
      return true;
    }

    // Fallback to cp -R (which also works well on macOS)
    const cpResult = child_process.spawnSync(
      "cp",
      ["-R", source, destination],
      {
        stdio: "inherit",
      }
    );

    if (cpResult.status === 0) {
      return true;
    }

    return false;
  } catch (error) {
    console.error("Copy directory error:", error);
    return false;
  }
};

/**
 * Verify that cache file exists and is valid
 */
const verifyCacheFile = (cachePath: string, platform: string): boolean => {
  if (!fs.existsSync(cachePath)) {
    return false;
  }

  const stats = fs.statSync(cachePath);
  if (!stats.isDirectory() && platform === "ios") {
    return false;
  }

  return true;
};

const plugin: BuildCacheProviderPlugin = {
  resolveBuildCache: async (props: ResolveBuildCacheProps, options) => {
    const { fingerprintHash, platform, projectRoot } = props;
    console.log(
      `Searching for cached build with fingerprint: ${fingerprintHash}`
    );

    const cacheFilePath = getCacheFilePath(fingerprintHash, platform);

    if (verifyCacheFile(cacheFilePath, platform)) {
      console.log(
        `Cache hit! Found build for ${platform} with fingerprint ${fingerprintHash}`
      );
      return cacheFilePath;
    }

    console.log(
      `Cache miss. No build found for ${platform} with fingerprint ${fingerprintHash}`
    );
    return null;
  },

  uploadBuildCache: async (props: UploadBuildCacheProps, options) => {
    const { fingerprintHash, platform, buildPath } = props;
    console.log(
      `Uploading build for ${platform} with fingerprint: ${fingerprintHash}`
    );

    const cacheFilePath = getCacheFilePath(fingerprintHash, platform);

    try {
      // Check if build artifact exists
      if (!fs.existsSync(buildPath)) {
        console.error(`Build artifact not found at: ${buildPath}`);
        return null;
      }

      // Get stats to check if it's a directory or file
      const stats = fs.statSync(buildPath);

      if (stats.isDirectory()) {
        console.log(`Copying directory: ${buildPath} -> ${cacheFilePath}`);
        const success = copyDirectory(buildPath, cacheFilePath);
        if (!success) {
          console.error("Failed to copy directory");
          return null;
        }
      } else {
        // It's a regular file, use copyFileSync
        console.log(`Copying file: ${buildPath} -> ${cacheFilePath}`);
        fs.copyFileSync(buildPath, cacheFilePath);
      }

      // Verify cache file was created successfully
      if (verifyCacheFile(cacheFilePath, platform)) {
        console.log(`Successfully cached build at: ${cacheFilePath}`);
        return cacheFilePath;
      } else {
        console.error(`Failed to verify cache file: ${cacheFilePath}`);
        return null;
      }
    } catch (error) {
      console.error("Error uploading build to cache:", error);
      return null;
    }
  },
};

export default plugin;
