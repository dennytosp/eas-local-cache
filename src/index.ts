import * as fs from "fs";
import * as path from "path";

import type {
  BuildCacheProviderPlugin,
  CalculateFingerprintHashProps,
  ResolveBuildCacheProps,
  UploadBuildCacheProps,
} from "@expo/config";

import { inventoryCache } from "./cache/catalog";
import { pruneCache } from "./cache/cleanup";
import {
  recordResolveEvent,
  type ResolveExplanationCode,
} from "./cache/events";
import { ensureProviderRoot } from "./cache/filesystem";
import { calculateProjectFingerprint } from "./cache/fingerprint";
import { createEffectiveEnvironmentIdentity } from "./cache/environment-key";
import {
  createCacheInsight,
  normalizeRunProfile,
  readInsight,
  runProfilesEqual,
  selectClosestInsight,
  type EnvironmentEvidenceCategory,
  type FingerprintSnapshot,
  type InsightCandidate,
  type RunProfile,
} from "./cache/insight";
import {
  normalizeCacheOptions,
  normalizeCompressionOptions,
  normalizeEnvironmentOptions,
  type CacheProviderOptions,
} from "./cache/options";
import { getCachePaths, getEntryId, type CachePlatform } from "./cache/paths";
import { writePolicyState } from "./cache/policy-state";
import {
  elapsedMilliseconds,
  estimateArtifactReadyDuration,
  estimateTimeSaved,
  monotonicNow,
} from "./cache/timing";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
  type CacheMissReason,
} from "./cache/store";
import { discoverToolchain } from "./cache/toolchain";

type CalculationState = {
  fingerprintHash: string;
  snapshot: FingerprintSnapshot | null;
  updatedAtMs: number;
};

const environmentEvidenceLabels: Record<
  EnvironmentEvidenceCategory,
  { code: ResolveExplanationCode; label: string }
> = {
  "build-profile": {
    code: "build-profile-changed",
    label:
      "build configuration, variant, scheme, or architecture selection changed",
  },
  xcode: { code: "xcode-changed", label: "Xcode changed" },
  "platform-sdk": {
    code: "platform-sdk-changed",
    label: "the platform SDK changed",
  },
  jdk: { code: "jdk-changed", label: "the JDK changed" },
  gradle: { code: "gradle-changed", label: "Gradle changed" },
  architecture: {
    code: "architecture-changed",
    label: "the host or target architecture changed",
  },
  "manual-environment": {
    code: "manual-environment-changed",
    label: "the manual environment context changed",
  },
  "key-schema": {
    code: "environment-key-upgraded",
    label: "the cache identity upgraded to environment-aware keying",
  },
};

type PendingBuild = {
  fingerprintHash: string;
  missStartedAtMs: number;
  ambiguous: boolean;
  missReason: CacheMissReason;
  compressedPayloadDigest?: string;
  updatedAtMs: number;
};

const LIFECYCLE_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_LIFECYCLE_STATES = 128;

const calculations = new Map<string, CalculationState>();
const pendingBuilds = new Map<string, PendingBuild>();

const pruneLifecycleMap = <State extends { updatedAtMs: number }>(
  states: Map<string, State>,
  nowMs: number
): void => {
  for (const [key, state] of states) {
    if (nowMs - state.updatedAtMs >= LIFECYCLE_STATE_TTL_MS) {
      states.delete(key);
    }
  }

  if (states.size <= MAX_LIFECYCLE_STATES) {
    return;
  }
  const oldest = [...states.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      left.updatedAtMs - right.updatedAtMs || leftKey.localeCompare(rightKey)
  );
  for (const [key] of oldest.slice(0, states.size - MAX_LIFECYCLE_STATES)) {
    states.delete(key);
  }
};

const pruneLifecycleState = (nowMs = Date.now()): void => {
  pruneLifecycleMap(calculations, nowMs);
  pruneLifecycleMap(pendingBuilds, nowMs);
};

const setCalculation = (
  key: string,
  state: Omit<CalculationState, "updatedAtMs">,
  nowMs: number
): void => {
  calculations.set(key, { ...state, updatedAtMs: nowMs });
  pruneLifecycleMap(calculations, nowMs);
};

const setPendingBuild = (
  key: string,
  state: Omit<PendingBuild, "updatedAtMs">,
  nowMs: number
): void => {
  pendingBuilds.set(key, { ...state, updatedAtMs: nowMs });
  pruneLifecycleMap(pendingBuilds, nowMs);
};

const shortFingerprint = (fingerprintHash: string): string =>
  fingerprintHash.replace(/[\r\n\t]/g, "").slice(0, 12);

const getStateKey = (
  projectRoot: string,
  platform: CachePlatform,
  profile: RunProfile,
  fingerprintHash: string
): string =>
  JSON.stringify([
    path.resolve(projectRoot),
    platform,
    profile,
    fingerprintHash,
  ]);

const getProfileState = (props: {
  projectRoot: string;
  platform: CachePlatform;
  runOptions: unknown;
  fingerprintHash: string;
}) => {
  const profile = normalizeRunProfile(props.platform, props.runOptions);
  return {
    profile,
    key: getStateKey(
      props.projectRoot,
      props.platform,
      profile,
      props.fingerprintHash
    ),
  };
};

const explanationForDirectReason = (
  reason: CacheMissReason
): { code: ResolveExplanationCode; message: string } => {
  switch (reason) {
    case "corrupt":
      return {
        code: "corrupt-entry",
        message: "the previous cache entry failed integrity validation",
      };
    case "lock-busy":
      return {
        code: "writer-lock-busy",
        message: "the cache entry is currently owned by another writer",
      };
    case "unsafe-legacy-path":
      return {
        code: "unsafe-legacy-path",
        message: "the legacy fingerprint path was unsafe",
      };
    case "legacy-invalid":
      return {
        code: "legacy-invalid",
        message: "the legacy artifact was incomplete or invalid",
      };
    case "compression-unavailable":
      return {
        code: "no-entry",
        message:
          "zstd is unavailable, so the compressed entry cannot be restored",
      };
    default:
      return { code: "no-entry", message: "no matching local entry exists" };
  }
};

const evidenceLabels = {
  "expo-config": {
    code: "expo-config-changed",
    label: "Expo config or config plugins changed",
  },
  "native-dependencies": {
    code: "native-dependencies-changed",
    label: "native dependencies or autolinking changed",
  },
  "native-project": {
    code: "native-project-changed",
    label: "native project inputs changed",
  },
  "project-metadata": {
    code: "project-metadata-changed",
    label: "project metadata or patches changed",
  },
  other: {
    code: "other-inputs-changed",
    label: "other native fingerprint inputs changed",
  },
} as const;

const findInsightExplanation = (
  projectRoot: string,
  current: FingerprintSnapshot
): { code: ResolveExplanationCode; messages: string[] } => {
  try {
    const catalog = inventoryCache(projectRoot);
    const candidates: InsightCandidate[] = [];
    for (const entry of catalog.entries) {
      if (entry.platform !== current.platform) {
        continue;
      }
      try {
        const insight = readInsight(entry.directory);
        if (
          insight &&
          insight.entryId === entry.entryId &&
          insight.fingerprintHash === entry.fingerprintHash &&
          insight.platform === entry.platform
        ) {
          candidates.push({
            insight,
            entryId: entry.entryId,
            createdAt: entry.createdAt,
            lastAccessAt: entry.lastAccessedAt,
          });
        }
      } catch {
        // Doctor reports malformed optional metadata; resolution remains usable.
      }
    }

    const closest = selectClosestInsight(current, candidates);
    if (closest.status === "fingerprint-engine-mismatch") {
      return {
        code: "fingerprint-engine-mismatch",
        messages: ["the Expo fingerprint engine version changed"],
      };
    }
    if (
      closest.status !== "match" ||
      (closest.diff.total === 0 && closest.environmentDiff.total === 0)
    ) {
      return {
        code: "no-compatible-insight",
        messages: ["no compatible prior fingerprint evidence is available"],
      };
    }

    const environmentGroups = closest.environmentDiff.groups.map(
      ({ category, count }) => ({
        code: environmentEvidenceLabels[category].code,
        message: `${environmentEvidenceLabels[category].label} (${count} field${
          count === 1 ? "" : "s"
        })`,
      })
    );
    const sourceGroups = closest.diff.groups.map(({ category, count }) => ({
      code: evidenceLabels[category].code,
      message: `${evidenceLabels[category].label} (${count} source${
        count === 1 ? "" : "s"
      })`,
    }));
    const groups = [...environmentGroups, ...sourceGroups].slice(0, 3);
    const first = groups[0];
    return {
      code: first?.code ?? "no-compatible-insight",
      messages: groups.map(({ message }) => message),
    };
  } catch {
    return {
      code: "no-compatible-insight",
      messages: ["no compatible prior fingerprint evidence is available"],
    };
  }
};

const recordEvent = async (
  props: ResolveBuildCacheProps,
  input: {
    outcome: "hit" | "miss" | "error";
    lookupDurationMs: number;
    explanationCode: ResolveExplanationCode;
    estimatedTimeSavedMs?: number;
  }
): Promise<void> => {
  try {
    const projectRoot = fs.realpathSync(props.projectRoot);
    const paths = getCachePaths(projectRoot);
    ensureProviderRoot(projectRoot, paths.providerRoot);
    const result = await recordResolveEvent(
      paths.providerRoot,
      paths.eventsRoot,
      {
        platform: props.platform,
        entryId: getEntryId(props.platform, props.fingerprintHash),
        ...input,
      }
    );
    if (result.status === "failed") {
      console.warn("Could not record cache telemetry", result.error.message);
    }
  } catch (error) {
    console.warn(
      "Could not record cache telemetry",
      error instanceof Error ? error.message : error
    );
  }
};

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
    console.log(`Searching for ${platform} cache entry ${fingerprint}`);

    try {
      const result = await resolveCacheEntryDetailed({
        projectRoot,
        platform,
        fingerprintHash,
      });
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
        if (result.materializedRestore) {
          try {
            const policy = normalizeCacheOptions(options);
            if (policy.autoPrune) {
              await pruneCache(projectRoot, policy, {
                protectedEntryIds: [getEntryId(platform, fingerprintHash)],
              });
            }
          } catch (error) {
            console.warn("Automatic restore cleanup was skipped", error);
          }
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
        try {
          const policy = normalizeCacheOptions(options);
          const paths = getCachePaths(projectRoot);
          writePolicyState(paths.providerRoot, paths.stateRoot, policy);
          if (policy.autoPrune) {
            const result = await pruneCache(projectRoot, policy, {
              protectedEntryIds: [entryId],
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
    } finally {
      calculations.delete(key);
      pendingBuilds.delete(key);
    }
  },
};

export default plugin;
