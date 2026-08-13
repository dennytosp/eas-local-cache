import { recordResolveEvent } from "../../src/cache/events";

const [providerRoot, eventsRoot, entryId] = process.argv.slice(2);
if (!providerRoot || !eventsRoot || !entryId) {
  throw new Error("Expected provider root, events root, and entry ID");
}

const result = await recordResolveEvent(
  providerRoot,
  eventsRoot,
  {
    platform: "ios",
    entryId,
    outcome: "hit",
    lookupDurationMs: 1,
    explanationCode: "hit",
  },
  { maxLockWaitMs: 2_000 }
);

if (result.status !== "recorded") {
  throw new Error(`Telemetry writer failed: ${result.status}`);
}
