import * as fs from "fs";
import * as path from "path";

import type { CachePlatform } from "./paths";

export const ARTIFACT_MTIME_METHOD = "artifact-mtime-v1" as const;
export const MAX_ARTIFACT_READY_DURATION_MS = 6 * 60 * 60 * 1000;
export const ARTIFACT_CLOCK_TOLERANCE_MS = 2000;

export type ArtifactReadyEstimate = {
  durationMs: number;
  method: typeof ARTIFACT_MTIME_METHOD;
};

type ArtifactReadyEstimateInput = {
  artifactPath: string;
  platform: CachePlatform;
  missStartedAtMs: number;
  uploadObservedAtMs: number;
};

const newestRegularFileMtime = (directory: string): number | null => {
  let newest: number | null = null;
  const pending = [directory];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of fs.readdirSync(current)) {
      visited += 1;
      if (visited > 100_000) {
        throw new Error("Artifact contains too many filesystem entries");
      }
      const candidate = path.join(current, child);
      const stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        pending.push(candidate);
      } else if (stats.isFile()) {
        newest =
          newest === null ? stats.mtimeMs : Math.max(newest, stats.mtimeMs);
      }
    }
  }
  return newest;
};

export const estimateArtifactReadyDuration = (
  input: ArtifactReadyEstimateInput
): ArtifactReadyEstimate | null => {
  try {
    if (
      !Number.isFinite(input.missStartedAtMs) ||
      !Number.isFinite(input.uploadObservedAtMs) ||
      input.uploadObservedAtMs < input.missStartedAtMs
    ) {
      return null;
    }
    const artifactStats = fs.lstatSync(input.artifactPath);
    if (artifactStats.isSymbolicLink()) {
      return null;
    }

    let artifactMtimeMs: number | null;
    if (input.platform === "android") {
      artifactMtimeMs = artifactStats.isFile() ? artifactStats.mtimeMs : null;
    } else {
      artifactMtimeMs = artifactStats.isDirectory()
        ? newestRegularFileMtime(input.artifactPath)
        : null;
    }
    if (artifactMtimeMs === null || !Number.isFinite(artifactMtimeMs)) {
      return null;
    }

    const rawDurationMs = artifactMtimeMs - input.missStartedAtMs;
    if (
      rawDurationMs < 0 ||
      rawDurationMs > MAX_ARTIFACT_READY_DURATION_MS ||
      artifactMtimeMs > input.uploadObservedAtMs + ARTIFACT_CLOCK_TOLERANCE_MS
    ) {
      return null;
    }
    const durationMs = Math.round(rawDurationMs);
    return { durationMs, method: ARTIFACT_MTIME_METHOD };
  } catch {
    return null;
  }
};

export const monotonicNow = (): bigint => process.hrtime.bigint();

export const elapsedMilliseconds = (
  startedAt: bigint,
  finishedAt: bigint = monotonicNow()
): number => {
  if (finishedAt < startedAt) {
    return 0;
  }
  return Number(finishedAt - startedAt) / 1_000_000;
};

export const estimateTimeSaved = (
  artifactReadyDurationMs: number | undefined,
  lookupDurationMs: number
): number | undefined => {
  if (
    artifactReadyDurationMs === undefined ||
    !Number.isFinite(artifactReadyDurationMs) ||
    artifactReadyDurationMs < 0 ||
    !Number.isFinite(lookupDurationMs) ||
    lookupDurationMs < 0
  ) {
    return undefined;
  }
  return Math.max(0, artifactReadyDurationMs - lookupDurationMs);
};
