import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  claimAutomaticPruneAttempt,
  rollbackAutomaticPruneAttempt,
} from "../src/cache/automatic-prune-state";
import { ensureProviderRoot } from "../src/cache/filesystem";
import { DEFAULT_CACHE_POLICY } from "../src/cache/options";
import { getCachePaths } from "../src/cache/paths";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("automatic cleanup attempt state", () => {
  it("rolls back only its exact claim and never a concurrent successor", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-auto-prune-state-"))
    );
    roots.push(root);
    const paths = getCachePaths(root);
    ensureProviderRoot(root, paths.providerRoot);
    const common = {
      providerRoot: paths.providerRoot,
      stateRoot: paths.stateRoot,
      locksRoot: paths.locksRoot,
      policy: { ...DEFAULT_CACHE_POLICY },
      throttleMs: 5 * 60 * 1000,
    };
    const first = await claimAutomaticPruneAttempt({
      ...common,
      force: false,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const successor = await claimAutomaticPruneAttempt({
      ...common,
      force: true,
      now: new Date("2026-08-13T00:00:01.000Z"),
    });
    if (
      !first.claimed ||
      !first.claim ||
      !successor.claimed ||
      !successor.claim
    ) {
      throw new Error("Expected persisted automatic cleanup claims");
    }

    expect(
      await rollbackAutomaticPruneAttempt({
        providerRoot: paths.providerRoot,
        stateRoot: paths.stateRoot,
        locksRoot: paths.locksRoot,
        claim: first.claim,
      })
    ).toBe(false);
    expect(
      await claimAutomaticPruneAttempt({
        ...common,
        force: false,
        now: new Date("2026-08-13T00:00:02.000Z"),
      })
    ).toEqual({ claimed: false, claim: null });
    expect(
      await rollbackAutomaticPruneAttempt({
        providerRoot: paths.providerRoot,
        stateRoot: paths.stateRoot,
        locksRoot: paths.locksRoot,
        claim: successor.claim,
      })
    ).toBe(true);
    expect(
      (
        await claimAutomaticPruneAttempt({
          ...common,
          force: false,
          now: new Date("2026-08-13T00:00:03.000Z"),
        })
      ).claimed
    ).toBe(true);
  });
});
