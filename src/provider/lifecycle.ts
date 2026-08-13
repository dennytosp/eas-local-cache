import * as path from "path";

import {
  normalizeRunProfile,
  type FingerprintSnapshot,
  type RunProfile,
} from "../cache/insight";
import type { CachePlatform } from "../cache/paths";
import type { CacheMissReason } from "../cache/store";

export type CalculationState = {
  fingerprintHash: string;
  snapshot: FingerprintSnapshot | null;
  updatedAtMs: number;
};

export type PendingBuild = {
  fingerprintHash: string;
  missStartedAtMs: number;
  ambiguous: boolean;
  missReason: CacheMissReason;
  compressedPayloadDigest?: string;
  updatedAtMs: number;
};

const LIFECYCLE_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_LIFECYCLE_STATES = 128;
export const calculations = new Map<string, CalculationState>();
export const pendingBuilds = new Map<string, PendingBuild>();

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

export const pruneLifecycleState = (nowMs = Date.now()): void => {
  pruneLifecycleMap(calculations, nowMs);
  pruneLifecycleMap(pendingBuilds, nowMs);
};

export const setCalculation = (
  key: string,
  state: Omit<CalculationState, "updatedAtMs">,
  nowMs: number
): void => {
  calculations.set(key, { ...state, updatedAtMs: nowMs });
  pruneLifecycleMap(calculations, nowMs);
};

export const setPendingBuild = (
  key: string,
  state: Omit<PendingBuild, "updatedAtMs">,
  nowMs: number
): void => {
  pendingBuilds.set(key, { ...state, updatedAtMs: nowMs });
  pruneLifecycleMap(pendingBuilds, nowMs);
};

export const shortFingerprint = (fingerprintHash: string): string =>
  fingerprintHash.replace(/[\r\n\t]/g, "").slice(0, 12);

export const getStateKey = (
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

export const getProfileState = (props: {
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
