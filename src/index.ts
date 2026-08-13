import * as fs from "fs";

import type {
  BuildCacheProviderPlugin,
  CalculateFingerprintHashProps,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";

import { calculateProjectFingerprint } from "./cache/fingerprint";
import { createEffectiveEnvironmentIdentity } from "./cache/environment-key";
import {
  createCacheInsight,
  normalizeRunProfile,
  readInsight,
  runProfilesEqual,
} from "./cache/insight";
import {
  normalizeCompressionOptions,
  normalizeEnvironmentOptions,
  normalizeLanOptions,
  type CacheProviderOptions,
} from "./cache/options";
import { getCachePaths, getEntryId } from "./cache/paths";
import {
  elapsedMilliseconds,
  estimateArtifactReadyDuration,
  estimateTimeSaved,
  monotonicNow,
} from "./cache/timing";
import { resolveCacheEntryDetailed, uploadCacheEntry } from "./cache/store";
import { discoverToolchain } from "./cache/toolchain";
import { readLanState } from "./lan/state";
import { fetchLanEntryToLocal, pushLanEntryToPeer } from "./lan/sync";
import {
  explanationForDirectReason,
  findInsightExplanation,
} from "./provider/explanations";
import {
  calculations,
  getProfileState,
  getStateKey,
  pendingBuilds,
  pruneLifecycleState,
  setCalculation,
  setPendingBuild,
  shortFingerprint,
} from "./provider/lifecycle";
import { recordLanPeerSuccess } from "./provider/lan";
import { runAutomaticPrune } from "./provider/maintenance";
import { recordEvent } from "./provider/telemetry";

const plugin: BuildCacheProviderPlugin<CacheProviderOptions> = {
  calculateFingerprintHash: async (
    props: CalculateFingerprintHashProps,
    options: CacheProviderOptions = {}
  ) => {
    pruneLifecycleState();
    try {
      normalizeCompressionOptions(options);
      const baseCalculation = await calculateProjectFingerprint(props);
      const environmentOptions = normalizeEnvironmentOptions(options);
      const profile = normalizeRunProfile(props.platform, props.runOptions);
      let toolchain = null;
      if (environmentOptions.toolchainMode !== "off") {
        const discovery = await discoverToolchain({
          projectRoot: props.projectRoot,
          platform: props.platform,
          runOptions: props.runOptions,
          mode: environmentOptions.toolchainMode,
        });
        if (discovery.status !== "available") {
          throw new Error(
            `toolchain discovery unavailable (${discovery.reason})`
          );
        }
        toolchain = discovery.snapshot;
      }
      const identity = createEffectiveEnvironmentIdentity({
        baseFingerprintHash: baseCalculation.fingerprintHash,
        platform: props.platform,
        runProfile: profile,
        toolchainMode: environmentOptions.toolchainMode,
        environmentKeyDigest: environmentOptions.environmentKeyDigest,
        toolchain: toolchain === null ? {} : { ...toolchain },
      });
      const snapshot = baseCalculation.snapshot
        ? {
            ...baseCalculation.snapshot,
            fingerprintHash: identity.effectiveFingerprintHash,
            baseFingerprintHash: identity.baseFingerprintHash,
            effectiveFingerprintHash: identity.effectiveFingerprintHash,
            keySchema: identity.keySchema,
            toolchainMode: identity.toolchainMode,
            toolchain,
            environmentKeyDigest: identity.environmentKeyDigest,
          }
        : null;
      const key = getStateKey(
        props.projectRoot,
        props.platform,
        profile,
        identity.effectiveFingerprintHash
      );
      setCalculation(
        key,
        { fingerprintHash: identity.effectiveFingerprintHash, snapshot },
        Date.now()
      );
      return identity.effectiveFingerprintHash;
    } catch (error) {
      console.warn(
        "Could not calculate the local build-cache fingerprint; caching is disabled for this build",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  },

  resolveBuildCache: async (
    props: ResolveBuildCacheProps,
    options: CacheProviderOptions = {}
  ) => {
    const { fingerprintHash, platform, projectRoot } = props;
    const fingerprint = shortFingerprint(fingerprintHash);
    const { key, profile } = getProfileState(props);
    const nowMs = Date.now();
    pruneLifecycleState(nowMs);
    const calculation = calculations.get(key);
    const currentSnapshot =
      calculation?.fingerprintHash === fingerprintHash
        ? calculation.snapshot
        : null;
    const startedAt = monotonicNow();
    let importedFromLan = false;
    console.log(`Searching for ${platform} cache entry ${fingerprint}`);

    try {
      let result = await resolveCacheEntryDetailed({
        projectRoot,
        platform,
        fingerprintHash,
      });
      if (result.outcome === "miss" && result.reason !== "lock-busy") {
        try {
          const { lanMode } = normalizeLanOptions(options);
          if (lanMode !== "off") {
            const paths = getCachePaths(fs.realpathSync(projectRoot));
            const state = readLanState(paths.providerRoot);
            if (state) {
              const fetched = await fetchLanEntryToLocal({
                projectRoot,
                clientId: state.clientId,
                peers: state.outboundPeers,
                platform,
                entryId: getEntryId(platform, fingerprintHash),
                ...(result.reason === "compression-unavailable" &&
                result.compressedPayloadDigest
                  ? {
                      replaceCompressedPayloadDigest:
                        result.compressedPayloadDigest,
                    }
                  : {}),
              });
              if (fetched.imported) {
                importedFromLan = true;
                result = await resolveCacheEntryDetailed({
                  projectRoot,
                  platform,
                  fingerprintHash,
                });
                if (result.outcome === "hit") {
                  if (fetched.peerId) {
                    await recordLanPeerSuccess(
                      paths.providerRoot,
                      fetched.peerId
                    ).catch(() => {});
                  }
                  console.log(
                    fetched.peerId
                      ? `LAN cache hit from peer ${fetched.peerId.slice(0, 12)}`
                      : "LAN cache entry became available locally"
                  );
                }
              }
            }
          }
        } catch (error) {
          console.warn(
            "LAN cache lookup was skipped; continuing with the local cache",
            error instanceof Error ? error.message : error
          );
        }
      }
      const lookupDurationMs = elapsedMilliseconds(startedAt);

      if (result.outcome === "hit") {
        let estimatedTimeSavedMs: number | undefined;
        if (result.source === "versioned") {
          try {
            const insight = readInsight(result.entryDirectory!);
            if (
              insight &&
              insight.entryId === getEntryId(platform, fingerprintHash) &&
              insight.fingerprintHash === fingerprintHash &&
              insight.platform === platform &&
              runProfilesEqual(platform, insight.runProfile, profile)
            ) {
              estimatedTimeSavedMs = estimateTimeSaved(
                insight.artifactReadyEstimate?.durationMs,
                lookupDurationMs
              );
            }
          } catch (error) {
            console.warn(
              "Ignored invalid cache insight",
              error instanceof Error ? error.message : error
            );
          }
        }
        await recordEvent(props, {
          outcome: "hit",
          lookupDurationMs,
          explanationCode: "hit",
          ...(estimatedTimeSavedMs === undefined
            ? {}
            : { estimatedTimeSavedMs }),
        });
        if (result.source === "versioned") {
          await runAutomaticPrune({
            projectRoot,
            options,
            protectedEntryId: getEntryId(platform, fingerprintHash),
            force: importedFromLan || result.materializedRestore,
          });
        }
        calculations.delete(key);
        pendingBuilds.delete(key);
        console.log(`Cache hit for ${platform} fingerprint ${fingerprint}`);
        return result.path;
      }

      const direct = explanationForDirectReason(result.reason);
      const explanation =
        result.reason === "not-found" && currentSnapshot
          ? findInsightExplanation(projectRoot, currentSnapshot)
          : { code: direct.code, messages: [direct.message] };
      const pending = pendingBuilds.get(key);
      setPendingBuild(
        key,
        {
          fingerprintHash,
          missStartedAtMs: pending?.missStartedAtMs ?? nowMs,
          ambiguous: Boolean(pending),
          missReason: result.reason,
          ...(result.compressedPayloadDigest
            ? { compressedPayloadDigest: result.compressedPayloadDigest }
            : {}),
        },
        nowMs
      );
      await recordEvent(props, {
        outcome: "miss",
        lookupDurationMs,
        explanationCode: explanation.code,
      });
      console.log(`Cache miss for ${platform} fingerprint ${fingerprint}`);
      for (const message of explanation.messages) {
        console.log(`Possible cause: ${message}`);
      }
      return null;
    } catch (error) {
      const lookupDurationMs = elapsedMilliseconds(startedAt);
      calculations.delete(key);
      pendingBuilds.delete(key);
      await recordEvent(props, {
        outcome: "error",
        lookupDurationMs,
        explanationCode: "provider-error",
      });
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
    const { key } = getProfileState(props);
    pruneLifecycleState();
    console.log(`Caching ${platform} build for fingerprint ${fingerprint}`);

    try {
      if (!buildPath) {
        console.warn("Expo did not provide a build artifact path");
        return null;
      }

      const entryId = getEntryId(platform, fingerprintHash);
      const calculation = calculations.get(key);
      const pending = pendingBuilds.get(key);
      let insight;
      if (
        calculation?.snapshot &&
        calculation.fingerprintHash === fingerprintHash
      ) {
        const estimate =
          pending &&
          !pending.ambiguous &&
          pending.fingerprintHash === fingerprintHash
            ? estimateArtifactReadyDuration({
                artifactPath: buildPath,
                platform,
                missStartedAtMs: pending.missStartedAtMs,
                uploadObservedAtMs: Date.now(),
              }) ?? undefined
            : undefined;
        try {
          insight = createCacheInsight(calculation.snapshot, entryId, estimate);
        } catch (error) {
          console.warn(
            "Could not prepare cache insight",
            error instanceof Error ? error.message : error
          );
        }
      }

      const cachePath = await uploadCacheEntry(
        { projectRoot, platform, fingerprintHash },
        buildPath,
        {
          ...(insight ? { insight } : {}),
          compressionMode: normalizeCompressionOptions(options).compressionMode,
          replaceCompressedUnavailable:
            pending?.missReason === "compression-unavailable" &&
            Boolean(pending.compressedPayloadDigest),
          ...(pending?.compressedPayloadDigest
            ? {
                replaceCompressedPayloadDigest: pending.compressedPayloadDigest,
              }
            : {}),
        }
      );
      console.log(`Cached ${platform} build at ${cachePath}`);

      if (cachePath) {
        await runAutomaticPrune({
          projectRoot,
          options,
          protectedEntryId: entryId,
          force: true,
        });
        try {
          const { lanMode } = normalizeLanOptions(options);
          if (lanMode === "read-write") {
            const paths = getCachePaths(fs.realpathSync(projectRoot));
            const state = readLanState(paths.providerRoot);
            if (state) {
              const pushed = await pushLanEntryToPeer({
                projectRoot,
                clientId: state.clientId,
                peers: state.outboundPeers,
                platform,
                entryId,
              });
              if (pushed.uploaded) {
                if (pushed.peerId) {
                  await recordLanPeerSuccess(
                    paths.providerRoot,
                    pushed.peerId
                  ).catch(() => {});
                }
                console.log(
                  `Shared cache entry with peer ${pushed.peerId?.slice(0, 12)}`
                );
              }
            }
          }
        } catch (error) {
          console.warn(
            "LAN cache upload was skipped; the local artifact remains usable",
            error instanceof Error ? error.message : error
          );
        }
      }
      return cachePath;
    } catch (error) {
      console.warn(
        "Cache upload failed; the native build remains usable",
        error
      );
      return null;
    } finally {
      calculations.delete(key);
      pendingBuilds.delete(key);
    }
  },
};

export default plugin;
