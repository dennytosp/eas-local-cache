import * as fs from "fs";

import type { ResolveBuildCacheProps } from "@expo/config";

import {
  recordResolveEvent,
  type ResolveExplanationCode,
} from "../cache/events";
import { ensureProviderRoot } from "../cache/filesystem";
import { getCachePaths, getEntryId } from "../cache/paths";

export const recordEvent = async (
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
