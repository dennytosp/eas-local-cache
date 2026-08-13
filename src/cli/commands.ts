import * as fs from "fs";

import { inventoryCache } from "../cache/catalog";
import { pruneCache } from "../cache/cleanup";
import { doctorCache, doctorCacheDeep } from "../cache/doctor";
import { scanResolveEvents, summarizeResolveEvents } from "../cache/events";
import { formatSizeBytes, normalizeCacheOptions } from "../cache/options";
import { readPolicyState } from "../cache/policy-state";
import { HELP, parseCliArguments, UsageError } from "./arguments";
import { checkedSum, formatDuration, formatSignedSize, printJson } from "./io";
import {
  runPairCommand,
  runPeersCommand,
  runServeCommand,
} from "./lan-commands";

export const runCli = async (arguments_: string[]): Promise<number> => {
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.command === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (!fs.existsSync(parsed.projectRoot)) {
      throw new UsageError(
        `Project root does not exist: ${parsed.projectRoot}`
      );
    }

    if (parsed.command === "serve") return await runServeCommand(parsed);
    if (parsed.command === "pair") return await runPairCommand(parsed);
    if (parsed.command === "peers") return await runPeersCommand(parsed);

    const catalog = inventoryCache(parsed.projectRoot);
    if (parsed.command === "list") {
      const entries = [...catalog.entries]
        .filter(
          (entry) => !parsed.platform || entry.platform === parsed.platform
        )
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            left.platform.localeCompare(right.platform) ||
            left.entryId.localeCompare(right.entryId)
        )
        .map((entry) => ({
          platform: entry.platform,
          entryId: entry.entryId,
          fingerprint: entry.fingerprintHash.slice(0, 12),
          sizeBytes: entry.sizeBytes,
          createdAt: entry.createdAt,
          lastAccessedAt: entry.lastAccessedAt,
          protectedUntil: entry.protectedUntil,
          encoding: entry.encoding,
          logicalArtifactBytes: entry.logicalArtifactBytes,
          payloadBytes: entry.payloadBytes,
          compressionRatio: entry.compressionRatio,
          grossCompressionSavedBytes: entry.grossCompressionSavedBytes,
          restoreBytes: entry.restoreBytes,
        }));
      const legacyEntries = catalog.legacyEntries.filter(
        (entry) => !parsed.platform || entry.platform === parsed.platform
      );
      if (parsed.json) {
        printJson({
          entries,
          legacyEntries,
          issues: catalog.issues,
        });
      } else if (entries.length === 0 && legacyEntries.length === 0) {
        console.log("No versioned cache entries found.");
      } else {
        for (const entry of entries) {
          console.log(
            `${entry.platform.padEnd(7)} ${entry.fingerprint} ${formatSizeBytes(
              entry.sizeBytes
            ).padStart(9)} ${entry.encoding.padEnd(4)} last used ${
              entry.lastAccessedAt
            }`
          );
          if (entry.encoding === "zstd") {
            console.log(
              `         logical ${formatSizeBytes(
                entry.logicalArtifactBytes
              )}, payload ${formatSizeBytes(entry.payloadBytes ?? 0)}, ratio ${(
                (entry.compressionRatio ?? 0) * 100
              ).toFixed(1)}%, gross saved ${formatSizeBytes(
                entry.grossCompressionSavedBytes
              )}, restore ${formatSizeBytes(entry.restoreBytes)}`
            );
          }
        }
        for (const entry of legacyEntries) {
          console.log(
            `${entry.platform.padEnd(7)} legacy       ${formatSizeBytes(
              entry.sizeBytes
            ).padStart(9)} unverified ${entry.path}`
          );
        }
      }
      return catalog.issues.some((issue) => issue.severity === "error") ? 1 : 0;
    }

    if (parsed.command === "stats") {
      const policy = readPolicyState(
        catalog.paths.providerRoot,
        catalog.paths.stateRoot
      );
      let telemetry;
      try {
        const scan = scanResolveEvents(catalog.paths.eventsRoot);
        telemetry = summarizeResolveEvents(
          scan.events.map(({ event }) => event)
        );
      } catch {
        telemetry = summarizeResolveEvents([]);
      }
      const grossSavedBytes = checkedSum(
        catalog.entries.map((entry) => entry.grossCompressionSavedBytes),
        "Compression savings"
      );
      const latestEntry = [...catalog.entries].sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          left.platform.localeCompare(right.platform) ||
          left.entryId.localeCompare(right.entryId)
      )[0];
      const output = {
        entryCount: catalog.entries.length,
        legacyEntryCount: catalog.legacyEntries.length,
        latestBuild: latestEntry
          ? {
              platform: latestEntry.platform,
              entryId: latestEntry.entryId,
              fingerprint: latestEntry.fingerprintHash.slice(0, 12),
              createdAt: latestEntry.createdAt,
              lastAccessedAt: latestEntry.lastAccessedAt,
              sizeBytes: latestEntry.sizeBytes,
              encoding: latestEntry.encoding,
            }
          : null,
        entriesByPlatform: {
          android: catalog.entries.filter(
            (entry) => entry.platform === "android"
          ).length,
          ios: catalog.entries.filter((entry) => entry.platform === "ios")
            .length,
        },
        usage: catalog.usage,
        compression: {
          compressedEntries: catalog.entries.filter(
            (entry) => entry.encoding === "zstd"
          ).length,
          logicalArtifactBytes: checkedSum(
            catalog.entries.map((entry) => entry.logicalArtifactBytes),
            "Logical artifact storage"
          ),
          payloadBytes: checkedSum(
            catalog.entries.map((entry) => entry.payloadBytes ?? 0),
            "Compressed payload storage"
          ),
          grossSavedBytes,
          restoreBytes: catalog.usage.restoreCommittedBytes,
          netSavedBytes: grossSavedBytes - catalog.usage.restoreCommittedBytes,
        },
        policy,
        hitRate: telemetry.hitRate,
        estimatedTimeSavedMs:
          telemetry.hits === telemetry.hitsWithoutEstimate
            ? null
            : telemetry.estimatedTimeSavedMs,
        telemetry: {
          scope: "recorded-retained-resolves",
          ...telemetry,
          invalidEventCount: catalog.telemetry.invalidEventCount,
        },
        issues: catalog.issues,
      };
      if (parsed.json) {
        printJson(output);
      } else {
        console.log(
          `${output.entryCount} entries using ${formatSizeBytes(
            output.usage.entriesBytes
          )} (${output.entriesByPlatform.ios} iOS, ${
            output.entriesByPlatform.android
          } Android)`
        );
        console.log(
          output.latestBuild === null
            ? "Latest build: unavailable (no versioned cache entries)"
            : `Latest build: ${output.latestBuild.platform} ${output.latestBuild.fingerprint} created ${output.latestBuild.createdAt}`
        );
        console.log(
          `Apparent managed cache bytes: ${formatSizeBytes(
            output.usage.managedBytes
          )}; provider and legacy bytes: ${formatSizeBytes(
            output.usage.totalBytes
          )}`
        );
        console.log(
          `Compression: ${
            output.compression.compressedEntries
          } entries represent ${formatSizeBytes(
            output.compression.logicalArtifactBytes
          )}; payloads ${formatSizeBytes(
            output.compression.payloadBytes
          )}; gross saved ${formatSizeBytes(
            output.compression.grossSavedBytes
          )}; restores ${formatSizeBytes(
            output.compression.restoreBytes
          )}; net saved ${formatSignedSize(output.compression.netSavedBytes)}`
        );
        console.log(
          output.hitRate === null
            ? "Hit rate: unavailable (no retained cache decisions)"
            : `Hit rate: ${(output.hitRate * 100).toFixed(1)}% (${
                telemetry.hits
              } hits / ${telemetry.hits + telemetry.misses} decisions)`
        );
        console.log(
          output.estimatedTimeSavedMs === null
            ? `Estimated time saved: unavailable (${telemetry.hitsWithoutEstimate} hits lacked timing data)`
            : `Estimated time saved: ~${formatDuration(
                output.estimatedTimeSavedMs
              )} (${telemetry.hitsWithoutEstimate} hits lacked timing data)`
        );
      }
      return catalog.issues.some((issue) => issue.severity === "error") ? 1 : 0;
    }

    if (parsed.command === "doctor") {
      const report = parsed.deep
        ? await doctorCacheDeep(parsed.projectRoot)
        : doctorCache(parsed.projectRoot);
      if (parsed.json) {
        printJson(report);
      } else if (report.healthy) {
        console.log(
          `Cache is healthy (${report.checkedEntries} entries and ${
            report.checkedRestores
          } restores checked${
            report.deep ? ", deep validation complete" : ""
          }).`
        );
      } else {
        for (const issue of report.issues) {
          console.log(
            `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`
          );
        }
      }
      if (!parsed.json) {
        console.log(
          `Compression storage: gross saved ${formatSizeBytes(
            report.compression.grossSavedBytes
          )}; restores ${formatSizeBytes(
            report.compression.restoreBytes
          )}; net saved ${formatSignedSize(report.compression.netSavedBytes)}.`
        );
      }
      return report.healthy ? 0 : 1;
    }

    let basePolicy;
    try {
      basePolicy = readPolicyState(
        catalog.paths.providerRoot,
        catalog.paths.stateRoot
      );
    } catch {
      basePolicy = normalizeCacheOptions();
    }
    let policy;
    try {
      policy = normalizeCacheOptions({
        maxSize: parsed.overrides.maxSize ?? basePolicy.maxSizeBytes,
        maxEntries: parsed.overrides.maxEntries ?? basePolicy.maxEntries,
        retentionDays:
          parsed.overrides.retentionDays ??
          (basePolicy.retentionMs === null
            ? null
            : basePolicy.retentionMs / (24 * 60 * 60 * 1000)),
        autoPrune: basePolicy.autoPrune,
      });
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : "Invalid cleanup policy"
      );
    }
    const result = await pruneCache(parsed.projectRoot, policy, {
      dryRun: parsed.dryRun,
    });
    if (parsed.json) {
      printJson(result);
    } else {
      const action = parsed.dryRun ? "Would remove" : "Removed";
      console.log(
        `${action} ${
          parsed.dryRun ? result.candidates.length : result.removed.length
        } source entries and ${
          parsed.dryRun
            ? result.auxiliaryCandidates.length
            : result.auxiliaryRemoved.length
        } auxiliary items; restore bytes ${formatSizeBytes(
          (parsed.dryRun ? result.auxiliaryCandidates : result.auxiliaryRemoved)
            .filter((candidate) => candidate.category === "restore")
            .reduce((total, candidate) => total + candidate.sizeBytes, 0)
        )}; reclaim ${formatSizeBytes(result.reclaimedBytes)} apparent bytes.`
      );
      if (result.skipped.length > 0) {
        console.log(`${result.skipped.length} entries were protected or busy.`);
      }
    }
    return result.limitsSatisfied && result.issues.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error("Run eas-local-cache --help for usage.");
      return 2;
    }
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
};
