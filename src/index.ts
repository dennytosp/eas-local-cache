import {
  BuildCacheProviderPlugin,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";

import { resolveCacheEntry, uploadCacheEntry } from "./cache/store";
import { pruneCache } from "./cache/cleanup";
import {
  normalizeCacheOptions,
  type CacheProviderOptions,
} from "./cache/options";
import { getCachePaths, getEntryId } from "./cache/paths";
import { writePolicyState } from "./cache/policy-state";

const shortFingerprint = (fingerprintHash: string): string =>
  fingerprintHash.replace(/[\r\n\t]/g, "").slice(0, 12);

const plugin: BuildCacheProviderPlugin<CacheProviderOptions> = {
  resolveBuildCache: async (
    props: ResolveBuildCacheProps,
    _options: CacheProviderOptions
  ) => {
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

  uploadBuildCache: async (
    props: UploadBuildCacheProps,
    options: CacheProviderOptions = {}
  ) => {
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

      if (cachePath) {
        try {
          const policy = normalizeCacheOptions(options);
          const paths = getCachePaths(projectRoot);
          writePolicyState(paths.providerRoot, paths.stateRoot, policy);
          if (policy.autoPrune) {
            const result = await pruneCache(projectRoot, policy, {
              protectedEntryIds: [getEntryId(platform, fingerprintHash)],
            });
            if (result.removed.length > 0) {
              console.log(
                `Pruned ${result.removed.length} old cache entr${
                  result.removed.length === 1 ? "y" : "ies"
                } (${result.reclaimedBytes} bytes)`
              );
            }
            if (!result.limitsSatisfied) {
              console.warn(
                "Cache limits remain exceeded because active or newly built entries were protected"
              );
            }
          }
        } catch (error) {
          console.warn("Automatic cache cleanup was skipped", error);
        }
      }
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
