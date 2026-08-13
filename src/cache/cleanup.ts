import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { readAccessRecord, removeAccessRecord } from "./access";
import {
  inventoryCache,
  type CacheCatalog,
  type CatalogEntry,
} from "./catalog";
import {
  assertManagedDirectory,
  calculatePathSize,
  ensureManagedDirectory,
  pathExists,
} from "./filesystem";
import { pruneResolveEvents, type ResolveEventPruneCandidate } from "./events";
import { acquireEntryLock, inspectEntryLock, releaseEntryLock } from "./lock";
import type { NormalizedCachePolicy } from "./options";

export type PruneReason = "expired" | "max-entries" | "max-size";

export type PruneCandidate = {
  entryId: string;
  platform: CatalogEntry["platform"];
  sizeBytes: number;
  lastAccessedAt: string;
  reason: PruneReason;
};

export type PruneResult = {
  dryRun: boolean;
  candidates: PruneCandidate[];
  removed: PruneCandidate[];
  auxiliaryCandidates: AuxiliaryPruneCandidate[];
  auxiliaryRemoved: AuxiliaryPruneCandidate[];
  telemetryCandidates: ResolveEventPruneCandidate[];
  telemetryRemoved: ResolveEventPruneCandidate[];
  telemetryReclaimedBytes: number;
  skipped: Array<{ entryId: string; reason: string }>;
  reclaimedBytes: number;
  remainingEntries: number;
  remainingBytes: number;
  limitsSatisfied: boolean;
  issues: string[];
};

export type AuxiliaryPruneCandidate = {
  path: string;
  category: "staging" | "quarantine" | "trash" | "invalid-entry" | "restore";
  sizeBytes: number;
  modifiedAt: string;
  entryId: string | null;
  reason: "abandoned" | "expired" | "max-size" | "source-removal";
};

export type PruneOptions = {
  dryRun?: boolean;
  now?: Date;
  protectedEntryIds?: Iterable<string>;
};

const compareLru = (left: CatalogEntry, right: CatalogEntry): number =>
  Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  `${left.platform}:${left.entryId}`.localeCompare(
    `${right.platform}:${right.entryId}`
  );

const getAuxiliaryEntryId = (
  category: AuxiliaryPruneCandidate["category"],
  name: string
): string | null => {
  const pattern =
    category === "staging"
      ? /^([a-f0-9]{64})-/
      : category === "restore"
      ? /^([a-f0-9]{64})$/
      : /^(?:android|ios)-([a-f0-9]{64})-/;
  return pattern.exec(name)?.[1] ?? null;
};

const listAuxiliary = (
  catalog: CacheCatalog,
  policy: NormalizedCachePolicy,
  nowMs: number,
  protectedEntryIds: ReadonlySet<string>
): AuxiliaryPruneCandidate[] => {
  const candidates: AuxiliaryPruneCandidate[] = [];
  if (policy.retentionMs !== null) {
    for (const entry of catalog.invalidEntries) {
      if (
        (!entry.entryId || !protectedEntryIds.has(entry.entryId)) &&
        (!entry.protectedUntil || Date.parse(entry.protectedUntil) <= nowMs) &&
        Date.parse(entry.modifiedAt) < nowMs - policy.retentionMs
      ) {
        candidates.push({
          path: entry.directory,
          category: "invalid-entry",
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
          entryId: entry.entryId,
          reason: "expired",
        });
      }
    }
  }
  const roots = [
    ["trash", catalog.paths.trashRoot],
    ["staging", catalog.paths.stagingRoot],
    ["staging", catalog.paths.restoreStagingRoot],
    ["quarantine", catalog.paths.quarantineRoot],
  ] as const;

  for (const restore of catalog.restores) {
    if (restore.metadataValid) continue;
    if (
      restore.entryId &&
      (protectedEntryIds.has(restore.entryId) ||
        (restore.sourceEntry?.protectedUntil &&
          Date.parse(restore.sourceEntry.protectedUntil) > nowMs))
    ) {
      continue;
    }
    candidates.push({
      path: restore.directory,
      category: "restore",
      sizeBytes: restore.sizeBytes,
      modifiedAt: restore.modifiedAt,
      entryId: restore.entryId,
      reason: "abandoned",
    });
  }

  const selectedRestorePaths = new Set(
    candidates
      .filter((candidate) => candidate.category === "restore")
      .map((candidate) => candidate.path)
  );
  for (const entry of catalog.entries) {
    const restorePath = path.join(
      catalog.paths.restoresRoot,
      entry.platform,
      entry.entryId
    );
    if (
      entry.restoreBytes > 0 &&
      !selectedRestorePaths.has(restorePath) &&
      policy.retentionMs !== null &&
      Date.parse(entry.lastAccessedAt) < nowMs - policy.retentionMs &&
      (!entry.protectedUntil || Date.parse(entry.protectedUntil) <= nowMs)
    ) {
      candidates.push({
        path: restorePath,
        category: "restore",
        sizeBytes: entry.restoreBytes,
        modifiedAt: entry.lastAccessedAt,
        entryId: entry.entryId,
        reason: "expired",
      });
    }
  }

  for (const [category, root] of roots) {
    if (!pathExists(root)) {
      continue;
    }
    try {
      assertManagedDirectory(catalog.paths.providerRoot, root);
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(root).sort()) {
      const candidatePath = path.join(root, name);
      const stats = fs.lstatSync(candidatePath);
      const modifiedAt = new Date(stats.mtimeMs).toISOString();
      const expired =
        policy.retentionMs !== null &&
        stats.mtimeMs < nowMs - policy.retentionMs;
      if (category !== "trash" && !expired) {
        continue;
      }
      candidates.push({
        path: candidatePath,
        category,
        sizeBytes: calculatePathSize(candidatePath),
        modifiedAt,
        entryId: getAuxiliaryEntryId(category, name),
        reason: category === "trash" ? "abandoned" : "expired",
      });
    }
  }

  return candidates.sort(
    (left, right) =>
      (left.category === "trash" ? -1 : 0) -
        (right.category === "trash" ? -1 : 0) ||
      Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt) ||
      left.path.localeCompare(right.path)
  );
};

const addAuxiliaryForSize = (
  catalog: CacheCatalog,
  selected: AuxiliaryPruneCandidate[],
  policy: NormalizedCachePolicy,
  nowMs: number,
  protectedEntryIds: ReadonlySet<string>
): AuxiliaryPruneCandidate[] => {
  if (policy.maxSizeBytes === null) {
    return selected;
  }
  const selectedPaths = new Set(selected.map((candidate) => candidate.path));
  let projectedBytes =
    catalog.usage.entriesBytes +
    catalog.usage.invalidEntriesBytes +
    catalog.usage.stagingBytes +
    catalog.usage.quarantineBytes +
    catalog.usage.trashBytes +
    catalog.usage.restoreCommittedBytes +
    catalog.usage.restoreStagingBytes -
    selected.reduce((total, candidate) => total + candidate.sizeBytes, 0);
  if (projectedBytes <= policy.maxSizeBytes) {
    return selected;
  }

  const remaining: AuxiliaryPruneCandidate[] = catalog.invalidEntries
    .filter(
      (entry) =>
        !selectedPaths.has(entry.directory) &&
        (!entry.entryId || !protectedEntryIds.has(entry.entryId)) &&
        (!entry.protectedUntil || Date.parse(entry.protectedUntil) <= nowMs)
    )
    .map((entry) => ({
      path: entry.directory,
      category: "invalid-entry" as const,
      sizeBytes: entry.sizeBytes,
      modifiedAt: entry.modifiedAt,
      entryId: entry.entryId,
      reason: "max-size" as const,
    }));
  for (const entry of catalog.entries) {
    const restorePath = path.join(
      catalog.paths.restoresRoot,
      entry.platform,
      entry.entryId
    );
    if (
      entry.restoreBytes > 0 &&
      !selectedPaths.has(restorePath) &&
      !protectedEntryIds.has(entry.entryId) &&
      (!entry.protectedUntil || Date.parse(entry.protectedUntil) <= nowMs)
    ) {
      remaining.push({
        path: restorePath,
        category: "restore",
        sizeBytes: entry.restoreBytes,
        modifiedAt: entry.lastAccessedAt,
        entryId: entry.entryId,
        reason: "max-size",
      });
    }
  }
  for (const [category, root] of [
    ["quarantine", catalog.paths.quarantineRoot],
    ["staging", catalog.paths.stagingRoot],
    ["staging", catalog.paths.restoreStagingRoot],
  ] as const) {
    if (!pathExists(root)) {
      continue;
    }
    try {
      assertManagedDirectory(catalog.paths.providerRoot, root);
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(root)) {
      const candidatePath = path.join(root, name);
      if (selectedPaths.has(candidatePath)) {
        continue;
      }
      const stats = fs.lstatSync(candidatePath);
      remaining.push({
        path: candidatePath,
        category,
        sizeBytes: calculatePathSize(candidatePath),
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        entryId: getAuxiliaryEntryId(category, name),
        reason: "max-size",
      });
    }
  }

  for (const candidate of remaining.sort(
    (left, right) =>
      Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt) ||
      left.path.localeCompare(right.path)
  )) {
    if (projectedBytes <= policy.maxSizeBytes) {
      break;
    }
    selected.push(candidate);
    selectedPaths.add(candidate.path);
    projectedBytes -= candidate.sizeBytes;
  }
  return selected;
};

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
          entryLock = await acquireEntryLock(
            catalog.paths.locksRoot,
            candidate.entryId,
            { maxWaitMs: 0, retryIntervalMs: 1 }
          );
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
