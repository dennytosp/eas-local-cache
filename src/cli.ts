#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";

import { inventoryCache } from "./cache/catalog";
import { pruneCache } from "./cache/cleanup";
import { doctorCache, doctorCacheDeep } from "./cache/doctor";
import { scanResolveEvents, summarizeResolveEvents } from "./cache/events";
import {
  formatSizeBytes,
  normalizeCacheOptions,
  type CacheProviderOptions,
} from "./cache/options";
import { readPolicyState } from "./cache/policy-state";

type ParsedArguments = {
  command: "help" | "stats" | "list" | "doctor" | "prune";
  projectRoot: string;
  json: boolean;
  dryRun: boolean;
  deep: boolean;
  platform: "android" | "ios" | null;
  overrides: CacheProviderOptions;
};

class UsageError extends Error {}

const HELP = `eas-local-cache — inspect and maintain the local Expo build cache

Usage:
  eas-local-cache stats [--project-root PATH] [--json]
  eas-local-cache list [--project-root PATH] [--platform ios|android] [--json]
  eas-local-cache doctor [--project-root PATH] [--deep] [--json]
  eas-local-cache prune [--project-root PATH] [--dry-run] [--json]
                         [--max-size SIZE] [--max-entries COUNT]
                         [--retention-days DAYS]

Sizes use binary units: B, KB, MB, GB, or TB.
`;

const requireValue = (arguments_: string[], index: number, option: string) => {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${option} requires a value`);
  }
  return value;
};

export const parseCliArguments = (
  arguments_: string[],
  cwd = process.cwd()
): ParsedArguments => {
  const commandValue = arguments_[0];
  const command =
    !commandValue || commandValue === "help" || commandValue === "--help"
      ? "help"
      : commandValue;
  if (!new Set(["help", "stats", "list", "doctor", "prune"]).has(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }

  const parsed: ParsedArguments = {
    command: command as ParsedArguments["command"],
    projectRoot: cwd,
    json: false,
    dryRun: false,
    deep: false,
    platform: null,
    overrides: {},
  };

  for (let index = 1; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (option === "--json") {
      parsed.json = true;
    } else if (option === "--dry-run") {
      parsed.dryRun = true;
    } else if (option === "--deep") {
      parsed.deep = true;
    } else if (option === "--project-root") {
      parsed.projectRoot = path.resolve(
        cwd,
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--platform") {
      const value = requireValue(arguments_, index, option);
      if (value !== "ios" && value !== "android") {
        throw new UsageError("--platform must be ios or android");
      }
      parsed.platform = value;
      index += 1;
    } else if (option === "--max-size") {
      parsed.overrides.maxSize = requireValue(arguments_, index, option);
      index += 1;
    } else if (option === "--max-entries") {
      parsed.overrides.maxEntries = Number(
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else if (option === "--retention-days") {
      parsed.overrides.retentionDays = Number(
        requireValue(arguments_, index, option)
      );
      index += 1;
    } else {
      throw new UsageError(`Unknown option: ${option}`);
    }
  }

  if (parsed.command !== "prune" && parsed.dryRun) {
    throw new UsageError("--dry-run is only valid with prune");
  }
  if (parsed.command !== "list" && parsed.platform) {
    throw new UsageError("--platform is only valid with list");
  }
  if (parsed.command !== "doctor" && parsed.deep) {
    throw new UsageError("--deep is only valid with doctor");
  }
  if (
    parsed.command !== "prune" &&
    Object.values(parsed.overrides).some((value) => value !== undefined)
  ) {
    throw new UsageError("Cleanup policy options are only valid with prune");
  }
  return parsed;
};

const printJson = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(remainingSeconds > 0 || (hours === 0 && minutes === 0)
      ? [`${remainingSeconds}s`]
      : []),
  ].join(" ");
};

const checkedSum = (values: Iterable<number>, label: string): number => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} contains an invalid byte count`);
    }
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`${label} exceeds the supported byte range`);
    }
  }
  return total;
};

const formatSignedSize = (bytes: number): string =>
  bytes < 0 ? `-${formatSizeBytes(Math.abs(bytes))}` : formatSizeBytes(bytes);

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

    const catalog = inventoryCache(parsed.projectRoot);
    if (parsed.command === "list") {
      const entries = catalog.entries
        .filter(
          (entry) => !parsed.platform || entry.platform === parsed.platform
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
      const output = {
        entryCount: catalog.entries.length,
        legacyEntryCount: catalog.legacyEntries.length,
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
