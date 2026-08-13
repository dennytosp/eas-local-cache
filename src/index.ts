import {
  BuildCacheProviderPlugin,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";

import { resolveCacheEntry, uploadCacheEntry } from "./cache/store";

const shortFingerprint = (fingerprintHash: string): string =>
  fingerprintHash.replace(/[\r\n\t]/g, "").slice(0, 12);

const plugin: BuildCacheProviderPlugin = {
  resolveBuildCache: async (props: ResolveBuildCacheProps) => {
    const { fingerprintHash, platform, projectRoot } = props;
    const fingerprint = shortFingerprint(fingerprintHash);
    console.log(`Searching for ${platform} cache entry ${fingerprint}`);

    try {
      const cachePath = await resolveCacheEntry({
        projectRoot,
        platform,
        fingerprintHash,
      });

      if (cachePath) {
        console.log(`Cache hit for ${platform} fingerprint ${fingerprint}`);
        return cachePath;
      }

      console.log(`Cache miss for ${platform} fingerprint ${fingerprint}`);
      return null;
    } catch (error) {
      console.warn(
        "Cache lookup failed; continuing with a native build",
        error
      );
      return null;
    }
  },

  uploadBuildCache: async (props: UploadBuildCacheProps) => {
    const { fingerprintHash, platform, buildPath, projectRoot } = props;
    const fingerprint = shortFingerprint(fingerprintHash);
    console.log(`Caching ${platform} build for fingerprint ${fingerprint}`);

    try {
      if (!buildPath) {
        console.warn("Expo did not provide a build artifact path");
        return null;
      }

      const cachePath = await uploadCacheEntry(
        { projectRoot, platform, fingerprintHash },
        buildPath
      );
      console.log(`Cached ${platform} build at ${cachePath}`);
      return cachePath;
    } catch (error) {
      console.warn(
        "Cache upload failed; the native build remains usable",
        error
      );
      return null;
    }
  },
};

export default plugin;
