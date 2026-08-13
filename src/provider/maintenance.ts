import * as fs from "fs";

import {
  claimAutomaticPruneAttempt,
  rollbackAutomaticPruneAttempt,
} from "../cache/automatic-prune-state";
import { pruneCache } from "../cache/cleanup";
import {
  normalizeCacheOptions,
  type CacheProviderOptions,
} from "../cache/options";
import { getCachePaths } from "../cache/paths";
import { writePolicyState } from "../cache/policy-state";

const AUTOMATIC_HIT_PRUNE_THROTTLE_MS = 5 * 60 * 1000;

export const runAutomaticPrune = async (input: {
  projectRoot: string;
  options: CacheProviderOptions;
  protectedEntryId: string;
  force: boolean;
}): Promise<void> => {
  try {
    const policy = normalizeCacheOptions(input.options);
    const managedProjectRoot = fs.realpathSync(input.projectRoot);
    if (!policy.autoPrune && !input.force) {
      return;
    }

    const paths = getCachePaths(managedProjectRoot);
    writePolicyState(paths.providerRoot, paths.stateRoot, policy);
    if (!policy.autoPrune) {
      return;
    }
    const claim = await claimAutomaticPruneAttempt({
      providerRoot: paths.providerRoot,
      stateRoot: paths.stateRoot,
      locksRoot: paths.locksRoot,
      policy,
      throttleMs: AUTOMATIC_HIT_PRUNE_THROTTLE_MS,
      force: input.force,
      now: new Date(Date.now()),
    });
    if (!claim.claimed) {
      return;
    }
    let result;
    try {
      result = await pruneCache(managedProjectRoot, policy, {
        protectedEntryIds: [input.protectedEntryId],
      });
    } catch (error) {
      if (claim.claim) {
        await rollbackAutomaticPruneAttempt({
          providerRoot: paths.providerRoot,
          stateRoot: paths.stateRoot,
          locksRoot: paths.locksRoot,
          claim: claim.claim,
        }).catch(() => {});
      }
      throw error;
    }
    if (result.removed.length > 0) {
      console.log(
        `Pruned ${result.removed.length} old cache entr${
          result.removed.length === 1 ? "y" : "ies"
        } (${result.reclaimedBytes} bytes)`
      );
    }
    if (!result.limitsSatisfied) {
      console.warn(
        "Cache limits remain exceeded because active or newly used entries were protected"
      );
    }
  } catch (error) {
    console.warn("Automatic cache cleanup was skipped", error);
  }
};
