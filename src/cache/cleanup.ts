import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { readAccessRecord, removeAccessRecord } from "./access";
import { inventoryCache, type CatalogEntry } from "./catalog";
import {
  assertManagedDirectory,
  ensureManagedDirectory,
  pathExists,
} from "./filesystem";
import { pruneResolveEvents } from "./events";
import { acquireEntryLock, inspectEntryLock, releaseEntryLock } from "./lock";
import type { NormalizedCachePolicy } from "./options";
import {
  addAuxiliaryForSize,
  listAuxiliary,
  type AuxiliaryPruneCandidate,
  type PruneCandidate,
  type PruneOptions,
  type PruneReason,
  type PruneResult,
} from "./cleanup-auxiliary";
export {
  type AuxiliaryPruneCandidate,
  type PruneCandidate,
  type PruneOptions,
  type PruneReason,
  type PruneResult,
} from "./cleanup-auxiliary";

const compareLru = (left: CatalogEntry, right: CatalogEntry): number =>
  Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  `${left.platform}:${left.entryId}`.localeCompare(
    `${right.platform}:${right.entryId}`
  );

export const planPrune = (
  entries: readonly CatalogEntry[],
  policy: NormalizedCachePolicy,
  options: PruneOptions = {}
): PruneCandidate[] => {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Prune requires a valid current date");
  }
  const protectedEntryIds = new Set(options.protectedEntryIds ?? []);
  const selected = new Set<string>();
  const candidates: PruneCandidate[] = [];
  let remainingCount = entries.length;
  let remainingBytes = entries.reduce(
    (total, entry) => total + entry.sizeBytes,
    0
  );

  const canSelect = (entry: CatalogEntry): boolean =>
    !protectedEntryIds.has(entry.entryId) &&
    (!entry.protectedUntil || Date.parse(entry.protectedUntil) <= nowMs);
  const select = (entry: CatalogEntry, reason: PruneReason) => {
    if (selected.has(entry.entryId) || !canSelect(entry)) {
      return;
    }
    selected.add(entry.entryId);
    remainingCount -= 1;
    remainingBytes -= entry.sizeBytes;
    candidates.push({
      entryId: entry.entryId,
      platform: entry.platform,
      sizeBytes: entry.sizeBytes,
      lastAccessedAt: entry.lastAccessedAt,
      reason,
    });
  };

  if (policy.retentionMs !== null) {
    const cutoff = nowMs - policy.retentionMs;
    for (const entry of [...entries].sort(compareLru)) {
      if (Date.parse(entry.lastAccessedAt) < cutoff) {
        select(entry, "expired");
      }
    }
  }

  const remainingLru = () =>
    [...entries]
      .filter((entry) => !selected.has(entry.entryId))
      .sort(compareLru);

  if (policy.maxEntries !== null) {
    for (const entry of remainingLru()) {
      if (remainingCount <= policy.maxEntries) {
        break;
      }
      select(entry, "max-entries");
    }
  }

  if (policy.maxSizeBytes !== null) {
    for (const entry of remainingLru()) {
      if (remainingBytes <= policy.maxSizeBytes) {
        break;
      }
      select(entry, "max-size");
    }
  }

  return candidates;
};

const isStillEligible = (
  candidate: PruneCandidate,
  lastAccessedAt: string,
  protectedUntil: string | null,
  policy: NormalizedCachePolicy,
  nowMs: number
): boolean => {
  if (protectedUntil && Date.parse(protectedUntil) > nowMs) {
    return false;
  }
  if (candidate.reason !== "expired") {
    return true;
  }
  return (
    policy.retentionMs !== null &&
    Date.parse(lastAccessedAt) < nowMs - policy.retentionMs
  );
};

const limitsSatisfied = (
  count: number,
  bytes: number,
  policy: NormalizedCachePolicy
): boolean =>
  (policy.maxEntries === null || count <= policy.maxEntries) &&
  (policy.maxSizeBytes === null || bytes <= policy.maxSizeBytes);

export const pruneCache = async (
  projectRoot: string,
  policy: NormalizedCachePolicy,
  options: PruneOptions = {}
): Promise<PruneResult> => {
  const catalog = inventoryCache(projectRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const telemetryPrune = await pruneResolveEvents(
    catalog.paths.providerRoot,
    catalog.paths.eventsRoot,
    { dryRun: options.dryRun, nowMs }
  );
  const telemetryCandidates =
    telemetryPrune.status === "pruned" ? telemetryPrune.candidates : [];
  const telemetryRemoved =
    telemetryPrune.status === "pruned" ? telemetryPrune.removed : [];
  const telemetryReclaimedBytes =
    telemetryPrune.status === "pruned" ? telemetryPrune.removedBytes : 0;
  const telemetryIssues =
    telemetryPrune.status === "failed"
      ? [`Could not prune telemetry: ${telemetryPrune.error.message}`]
      : telemetryPrune.status === "lock-busy"
      ? ["Could not acquire the telemetry maintenance lock"]
      : [];
  const protectedEntryIds = new Set(options.protectedEntryIds ?? []);
  const auxiliaryCandidates = addAuxiliaryForSize(
    catalog,
    listAuxiliary(catalog, policy, nowMs, protectedEntryIds),
    policy,
    nowMs,
    protectedEntryIds
  );
  let auxiliaryReclaimableBytes = auxiliaryCandidates.reduce(
    (total, candidate) => total + candidate.sizeBytes,
    0
  );
  const auxiliaryBytes =
    catalog.usage.invalidEntriesBytes +
    catalog.usage.stagingBytes +
    catalog.usage.quarantineBytes +
    catalog.usage.trashBytes +
    catalog.usage.restoreCommittedBytes +
    catalog.usage.restoreStagingBytes;
  const entryPolicy = {
    ...policy,
    maxSizeBytes:
      policy.maxSizeBytes === null
        ? null
        : Math.max(
            0,
            policy.maxSizeBytes -
              Math.max(0, auxiliaryBytes - auxiliaryReclaimableBytes)
          ),
  };
  let candidates = planPrune(catalog.entries, entryPolicy, options);
  const auxiliaryPaths = new Set(
    auxiliaryCandidates.map((candidate) => candidate.path)
  );
  if (options.dryRun) {
    for (const candidate of candidates) {
      const entry = catalog.entries.find(
        (item) => item.entryId === candidate.entryId
      );
      if (!entry || entry.restoreBytes === 0) continue;
      const restorePath = path.join(
        catalog.paths.restoresRoot,
        entry.platform,
        entry.entryId
      );
      if (auxiliaryPaths.has(restorePath)) continue;
      auxiliaryCandidates.push({
        path: restorePath,
        category: "restore",
        sizeBytes: entry.restoreBytes,
        modifiedAt: entry.lastAccessedAt,
        entryId: entry.entryId,
        reason: "source-removal",
      });
      auxiliaryPaths.add(restorePath);
      auxiliaryReclaimableBytes += entry.restoreBytes;
    }
  }
  const initialBytes = catalog.usage.entriesBytes;
  const initialCount = catalog.entries.length;

  if (options.dryRun || !pathExists(catalog.paths.providerRoot)) {
    const reclaimedBytes =
      auxiliaryReclaimableBytes +
      candidates.reduce((total, entry) => total + entry.sizeBytes, 0);
    const remainingBytes = Math.max(
      0,
      initialBytes + auxiliaryBytes - reclaimedBytes
    );
    return {
      dryRun: Boolean(options.dryRun),
      candidates,
      removed: [],
      auxiliaryCandidates,
      auxiliaryRemoved: [],
      telemetryCandidates,
      telemetryRemoved,
      telemetryReclaimedBytes,
      skipped: [],
      reclaimedBytes,
      remainingEntries: initialCount - candidates.length,
      remainingBytes,
      limitsSatisfied: limitsSatisfied(
        initialCount - candidates.length,
        remainingBytes,
        policy
      ),
      issues: [
        ...catalog.issues.map((issue) => `${issue.code}: ${issue.message}`),
        ...telemetryIssues,
      ],
    };
  }

  ensureManagedDirectory(catalog.paths.providerRoot, catalog.paths.locksRoot);
  const maintenanceLock = await acquireEntryLock(
    catalog.paths.locksRoot,
    "maintenance",
    { maxWaitMs: 250, retryIntervalMs: 25 }
  );
  if (!maintenanceLock) {
    return {
      dryRun: false,
      candidates,
      removed: [],
      auxiliaryCandidates,
      auxiliaryRemoved: [],
      telemetryCandidates,
      telemetryRemoved,
      telemetryReclaimedBytes,
      skipped: candidates.map((entry) => ({
        entryId: entry.entryId,
        reason: "maintenance is already running",
      })),
      reclaimedBytes: 0,
      remainingEntries: initialCount,
      remainingBytes: initialBytes + auxiliaryBytes,
      limitsSatisfied: limitsSatisfied(
        initialCount,
        initialBytes + auxiliaryBytes,
        policy
      ),
      issues: ["Could not acquire the maintenance lock", ...telemetryIssues],
    };
  }

  const removed: PruneCandidate[] = [];
  const auxiliaryRemoved: AuxiliaryPruneCandidate[] = [];
  const skipped: PruneResult["skipped"] = [];
  const issues = catalog.issues.map(
    (issue) => `${issue.code}: ${issue.message}`
  );
  issues.push(...telemetryIssues);
  let sourceCatalog = catalog;
  try {
    ensureManagedDirectory(catalog.paths.providerRoot, catalog.paths.trashRoot);
    for (const candidate of auxiliaryCandidates) {
      let entryLock = null;
      try {
        if (!pathExists(candidate.path)) {
          continue;
        }
        if (candidate.entryId) {
          const lockRoot =
            candidate.category === "transfer-staging"
              ? catalog.paths.transferLocksRoot
              : catalog.paths.locksRoot;
          ensureManagedDirectory(catalog.paths.providerRoot, lockRoot);
          entryLock = await acquireEntryLock(lockRoot, candidate.entryId, {
            maxWaitMs: 0,
            retryIntervalMs: 1,
          });
          if (!entryLock) {
            skipped.push({
              entryId: candidate.entryId,
              reason: `${candidate.category} data has an active writer`,
            });
            continue;
          }
          try {
            const currentAccess = readAccessRecord(
              catalog.paths.accessRoot,
              candidate.entryId,
              catalog.paths.providerRoot
            );
            if (
              currentAccess &&
              Date.parse(currentAccess.protectedUntil) > nowMs
            ) {
              skipped.push({
                entryId: candidate.entryId,
                reason: `${candidate.category} data is protected by an active lease`,
              });
              continue;
            }
          } catch (error) {
            issues.push(
              `Could not re-read access metadata for ${candidate.entryId}: ${
                error instanceof Error ? error.message : "unknown error"
              }`
            );
            continue;
          }
        }
        if (candidate.category === "invalid-entry") {
          assertManagedDirectory(
            catalog.paths.providerRoot,
            path.dirname(candidate.path)
          );
          const tombstone = path.join(
            catalog.paths.trashRoot,
            `invalid-${crypto.randomUUID()}`
          );
          fs.renameSync(candidate.path, tombstone);
          fs.rmSync(tombstone, { recursive: true, force: true });
        } else if (candidate.category === "restore") {
          assertManagedDirectory(
            catalog.paths.providerRoot,
            path.dirname(candidate.path)
          );
          const tombstone = path.join(
            catalog.paths.trashRoot,
            `restore-${candidate.entryId ?? "orphan"}-${crypto.randomUUID()}`
          );
          fs.renameSync(candidate.path, tombstone);
          fs.rmSync(tombstone, { recursive: true, force: true });
        } else {
          fs.rmSync(candidate.path, { recursive: true, force: true });
        }
        auxiliaryRemoved.push(candidate);
      } catch (error) {
        issues.push(
          `Could not prune ${candidate.category} data: ${
            error instanceof Error ? error.message : "unknown error"
          }`
        );
      } finally {
        if (entryLock) {
          releaseEntryLock(entryLock);
        }
      }
    }

    sourceCatalog = inventoryCache(projectRoot);
    const remainingAuxiliaryBytes = Math.max(
      0,
      sourceCatalog.usage.managedBytes - sourceCatalog.usage.entriesBytes
    );
    candidates = planPrune(
      sourceCatalog.entries,
      {
        ...policy,
        maxSizeBytes:
          policy.maxSizeBytes === null
            ? null
            : Math.max(0, policy.maxSizeBytes - remainingAuxiliaryBytes),
      },
      options
    );

    for (const candidate of candidates) {
      const entry = sourceCatalog.entries.find(
        (item) => item.entryId === candidate.entryId
      );
      if (!entry || !pathExists(entry.directory)) {
        skipped.push({
          entryId: candidate.entryId,
          reason: "entry disappeared before cleanup",
        });
        continue;
      }

      const lockInspection = inspectEntryLock(
        catalog.paths.locksRoot,
        candidate.entryId
      );
      if (lockInspection.exists && !lockInspection.stale) {
        skipped.push({
          entryId: candidate.entryId,
          reason: "entry has an active lock",
        });
        continue;
      }

      const entryLock = await acquireEntryLock(
        catalog.paths.locksRoot,
        candidate.entryId,
        { maxWaitMs: 0, retryIntervalMs: 1 }
      );
      if (!entryLock) {
        skipped.push({
          entryId: candidate.entryId,
          reason: "entry lock is unavailable",
        });
        continue;
      }

      try {
        if (!pathExists(entry.directory)) {
          continue;
        }
        try {
          const currentAccess = readAccessRecord(
            catalog.paths.accessRoot,
            candidate.entryId,
            catalog.paths.providerRoot
          );
          const plannedAccessMs = Date.parse(candidate.lastAccessedAt);
          if (
            currentAccess &&
            (Date.parse(currentAccess.lastAccessedAt) > plannedAccessMs ||
              !isStillEligible(
                candidate,
                currentAccess.lastAccessedAt,
                currentAccess.protectedUntil,
                policy,
                nowMs
              ))
          ) {
            skipped.push({
              entryId: candidate.entryId,
              reason: "entry was accessed after cleanup planning",
            });
            continue;
          }
        } catch (error) {
          issues.push(
            `Could not re-read access metadata for ${candidate.entryId}: ${
              error instanceof Error ? error.message : "unknown error"
            }`
          );
        }

        const tombstone = path.join(
          catalog.paths.trashRoot,
          `${candidate.platform}-${candidate.entryId}-${crypto.randomUUID()}`
        );
        fs.renameSync(entry.directory, tombstone);
        const restoreDirectory = path.join(
          catalog.paths.restoresRoot,
          candidate.platform,
          candidate.entryId
        );
        let restoreTombstone: string | null = null;
        let removedRestore: AuxiliaryPruneCandidate | null = null;
        if (pathExists(restoreDirectory)) {
          try {
            assertManagedDirectory(
              catalog.paths.providerRoot,
              path.dirname(restoreDirectory)
            );
            restoreTombstone = path.join(
              catalog.paths.trashRoot,
              `restore-${candidate.entryId}-${crypto.randomUUID()}`
            );
            fs.renameSync(restoreDirectory, restoreTombstone);
            removedRestore = auxiliaryCandidates.find(
              (auxiliary) => auxiliary.path === restoreDirectory
            ) ?? {
              path: restoreDirectory,
              category: "restore",
              sizeBytes: entry.restoreBytes,
              modifiedAt: entry.lastAccessedAt,
              entryId: entry.entryId,
              reason: "source-removal",
            };
            if (
              !auxiliaryCandidates.some(
                (auxiliary) => auxiliary.path === restoreDirectory
              )
            ) {
              auxiliaryCandidates.push(removedRestore);
            }
          } catch (error) {
            if (!pathExists(entry.directory) && pathExists(tombstone)) {
              fs.renameSync(tombstone, entry.directory);
            }
            throw error;
          }
        }
        try {
          removeAccessRecord(
            catalog.paths.accessRoot,
            candidate.entryId,
            catalog.paths.providerRoot
          );
        } catch (error) {
          issues.push(
            `Could not remove access metadata for ${candidate.entryId}: ${
              error instanceof Error ? error.message : "unknown error"
            }`
          );
        }
        removed.push(candidate);
        if (removedRestore) auxiliaryRemoved.push(removedRestore);
        for (const disposable of [tombstone, restoreTombstone]) {
          if (!disposable) continue;
          try {
            fs.rmSync(disposable, { recursive: true, force: true });
          } catch (error) {
            issues.push(
              `Could not remove cleanup tombstone: ${
                error instanceof Error ? error.message : "unknown error"
              }`
            );
          }
        }
      } catch (error) {
        issues.push(
          `Could not prune ${candidate.entryId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`
        );
      } finally {
        releaseEntryLock(entryLock);
      }
    }
  } finally {
    releaseEntryLock(maintenanceLock);
  }

  const finalCatalog = inventoryCache(projectRoot);
  const remainingEntries = finalCatalog.entries.length;
  const remainingBytes = finalCatalog.usage.managedBytes;
  const reclaimedBytes = Math.max(
    0,
    catalog.usage.managedBytes - remainingBytes
  );
  return {
    dryRun: false,
    candidates,
    removed,
    auxiliaryCandidates,
    auxiliaryRemoved,
    telemetryCandidates,
    telemetryRemoved,
    telemetryReclaimedBytes,
    skipped,
    reclaimedBytes,
    remainingEntries,
    remainingBytes,
    limitsSatisfied: limitsSatisfied(remainingEntries, remainingBytes, policy),
    issues,
  };
};
