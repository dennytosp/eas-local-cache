import * as fs from "fs";
import * as path from "path";

import type { CacheCatalog, CatalogEntry } from "./catalog";
import {
  assertManagedDirectory,
  calculatePathSize,
  pathExists,
} from "./filesystem";
import type { ResolveEventPruneCandidate } from "./events";
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
  category:
    | "staging"
    | "transfer-staging"
    | "quarantine"
    | "trash"
    | "invalid-entry"
    | "restore";
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

const getAuxiliaryEntryId = (
  category: AuxiliaryPruneCandidate["category"],
  name: string
): string | null => {
  const pattern =
    category === "staging" || category === "transfer-staging"
      ? /^([a-f0-9]{64})-/
      : category === "restore"
      ? /^([a-f0-9]{64})$/
      : /^(?:android|ios)-([a-f0-9]{64})-/;
  return pattern.exec(name)?.[1] ?? null;
};

export const listAuxiliary = (
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
    ["transfer-staging", catalog.paths.transferStagingRoot],
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

export const addAuxiliaryForSize = (
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
    ["transfer-staging", catalog.paths.transferStagingRoot],
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
