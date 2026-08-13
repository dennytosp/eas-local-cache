import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { ensureManagedDirectory } from "./filesystem";
import { acquireEntryLock, releaseEntryLock } from "./lock";
import type { NormalizedCachePolicy } from "./options";

const AUTOMATIC_PRUNE_STATE_SCHEMA_VERSION = 1;
const AUTOMATIC_PRUNE_STATE_FILENAME = "automatic-prune.json";
const MAX_AUTOMATIC_PRUNE_STATE_BYTES = 4 * 1024;
const AUTOMATIC_PRUNE_LOCK_ID = crypto
  .createHash("sha256")
  .update("automatic-prune-state", "utf8")
  .digest("hex");

type AutomaticPruneState = {
  schemaVersion: 1;
  attemptId: string;
  policyDigest: string;
  attemptedAt: string;
};

export type AutomaticPruneClaim = Omit<AutomaticPruneState, "schemaVersion">;
export type AutomaticPruneClaimResult =
  | { claimed: false; claim: null }
  | { claimed: true; claim: AutomaticPruneClaim | null };

const policyDigest = (policy: NormalizedCachePolicy): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        maxSizeBytes: policy.maxSizeBytes,
        maxEntries: policy.maxEntries,
        retentionMs: policy.retentionMs,
        autoPrune: policy.autoPrune,
      }),
      "utf8"
    )
    .digest("hex");

const parseState = (value: unknown): AutomaticPruneState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed automatic cleanup state");
  }
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  if (
    keys.join(",") !== "attemptId,attemptedAt,policyDigest,schemaVersion" ||
    state.schemaVersion !== AUTOMATIC_PRUNE_STATE_SCHEMA_VERSION ||
    typeof state.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      state.attemptId
    ) ||
    typeof state.policyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.policyDigest) ||
    typeof state.attemptedAt !== "string"
  ) {
    throw new Error("Malformed automatic cleanup state fields");
  }
  const attemptedAt = new Date(state.attemptedAt);
  if (
    !Number.isFinite(attemptedAt.getTime()) ||
    attemptedAt.toISOString() !== state.attemptedAt
  ) {
    throw new Error("Invalid automatic cleanup timestamp");
  }
  return state as AutomaticPruneState;
};

const readState = (providerRoot: string, stateRoot: string) => {
  try {
    ensureManagedDirectory(providerRoot, stateRoot);
    const descriptor = fs.openSync(
      path.join(stateRoot, AUTOMATIC_PRUNE_STATE_FILENAME),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    );
    try {
      const stats = fs.fstatSync(descriptor);
      if (
        !stats.isFile() ||
        stats.size <= 0 ||
        stats.size > MAX_AUTOMATIC_PRUNE_STATE_BYTES
      ) {
        throw new Error("Automatic cleanup state must be a bounded file");
      }
      return parseState(JSON.parse(fs.readFileSync(descriptor, "utf8")));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Mutable state is an optimization only; invalid data never blocks cleanup.
    return null;
  }
};

const writeState = (
  providerRoot: string,
  stateRoot: string,
  state: AutomaticPruneState
): void => {
  ensureManagedDirectory(providerRoot, stateRoot);
  const temporary = path.join(
    stateRoot,
    `.automatic-prune.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(
      temporary,
      path.join(stateRoot, AUTOMATIC_PRUNE_STATE_FILENAME)
    );
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

export const claimAutomaticPruneAttempt = async (input: {
  providerRoot: string;
  stateRoot: string;
  locksRoot: string;
  policy: NormalizedCachePolicy;
  throttleMs: number;
  force: boolean;
  now?: Date;
}): Promise<AutomaticPruneClaimResult> => {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(input.throttleMs) ||
    input.throttleMs < 0
  ) {
    throw new Error("Invalid automatic cleanup claim options");
  }

  ensureManagedDirectory(input.providerRoot, input.locksRoot);
  const lock = await acquireEntryLock(
    input.locksRoot,
    AUTOMATIC_PRUNE_LOCK_ID,
    { maxWaitMs: 250, retryIntervalMs: 25 }
  );
  if (!lock) {
    return input.force
      ? { claimed: true, claim: null }
      : { claimed: false, claim: null };
  }

  try {
    const digest = policyDigest(input.policy);
    const previous = readState(input.providerRoot, input.stateRoot);
    const elapsedMs = previous
      ? nowMs - Date.parse(previous.attemptedAt)
      : null;
    if (
      !input.force &&
      previous?.policyDigest === digest &&
      elapsedMs !== null &&
      elapsedMs >= 0 &&
      elapsedMs < input.throttleMs
    ) {
      return { claimed: false, claim: null };
    }
    const claim: AutomaticPruneClaim = {
      attemptId: crypto.randomUUID(),
      policyDigest: digest,
      attemptedAt: now.toISOString(),
    };
    try {
      writeState(input.providerRoot, input.stateRoot, {
        schemaVersion: AUTOMATIC_PRUNE_STATE_SCHEMA_VERSION,
        ...claim,
      });
    } catch {
      // The marker only avoids repeated scans; failure must not disable cleanup.
      return { claimed: true, claim: null };
    }
    return { claimed: true, claim };
  } finally {
    releaseEntryLock(lock);
  }
};

export const rollbackAutomaticPruneAttempt = async (input: {
  providerRoot: string;
  stateRoot: string;
  locksRoot: string;
  claim: AutomaticPruneClaim;
}): Promise<boolean> => {
  ensureManagedDirectory(input.providerRoot, input.locksRoot);
  const lock = await acquireEntryLock(
    input.locksRoot,
    AUTOMATIC_PRUNE_LOCK_ID,
    { maxWaitMs: 250, retryIntervalMs: 25 }
  );
  if (!lock) {
    return false;
  }
  try {
    const current = readState(input.providerRoot, input.stateRoot);
    if (
      !current ||
      current.attemptId !== input.claim.attemptId ||
      current.policyDigest !== input.claim.policyDigest ||
      current.attemptedAt !== input.claim.attemptedAt
    ) {
      return false;
    }
    fs.unlinkSync(path.join(input.stateRoot, AUTOMATIC_PRUNE_STATE_FILENAME));
    return true;
  } finally {
    releaseEntryLock(lock);
  }
};
