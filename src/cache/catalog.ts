import * as fs from "fs";
import * as path from "path";

import { readAccessRecord } from "./access";
import { scanResolveEvents } from "./events";
import {
  assertManagedDirectory,
  assertProviderRoot,
  calculatePathSize,
  pathExists,
} from "./filesystem";
import { readManifest, type CacheManifest } from "./manifest";
import { getCachePaths, type CachePaths, type CachePlatform } from "./paths";

export type CatalogEntry = {
  platform: CachePlatform;
  entryId: string;
  fingerprintHash: string;
  directory: string;
  sizeBytes: number;
  createdAt: string;
  lastAccessedAt: string;
  protectedUntil: string | null;
  manifest: CacheManifest;
  accessIssue: string | null;
  encoding: "none" | "zstd";
  logicalArtifactBytes: number;
  payloadBytes: number | null;
  compressionRatio: number | null;
  grossCompressionSavedBytes: number;
  restoreBytes: number;
};

export type CatalogRestore = {
  platform: CachePlatform | null;
  entryId: string | null;
  directory: string;
  sizeBytes: number;
  modifiedAt: string;
  sourceEntry: CatalogEntry | null;
  metadataValid: boolean;
  metadataIssue: string | null;
};

export type CatalogIssue = {
  code: string;
  path: string;
  message: string;
  severity: "warning" | "error";
};

export type CacheCatalog = {
  projectRoot: string;
  paths: CachePaths;
  entries: CatalogEntry[];
  restores: CatalogRestore[];
  invalidEntries: Array<{
    platform: CachePlatform | null;
    entryId: string | null;
    directory: string;
    sizeBytes: number;
    modifiedAt: string;
    protectedUntil: string | null;
  }>;
  issues: CatalogIssue[];
  telemetry: {
    eventCount: number;
    invalidEventCount: number;
  };
  usage: {
    entriesBytes: number;
    invalidEntriesBytes: number;
    stagingBytes: number;
    quarantineBytes: number;
    trashBytes: number;
    accessBytes: number;
    stateBytes: number;
    locksBytes: number;
    eventsBytes: number;
    restoreCommittedBytes: number;
    restoreStagingBytes: number;
    otherBytes: number;
    legacyBytes: number;
    managedBytes: number;
    totalBytes: number;
  };
  legacyEntries: Array<{
    platform: CachePlatform;
    path: string;
    sizeBytes: number;
  }>;
};

const ENTRY_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RESTORE_MANIFEST_BYTES = 16 * 1024;

const readRestoreMetadata = (
  directory: string,
  sourceEntry: CatalogEntry
): string | null => {
  const manifestPath = path.join(directory, "restore.json");
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > MAX_RESTORE_MANIFEST_BYTES
    ) {
      return "Restore manifest must be a bounded regular file";
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "Restore manifest is malformed";
    }
    const record = parsed as Record<string, unknown>;
    if (sourceEntry.manifest.schemaVersion !== 2) {
      return "Restore source entry is not compressed";
    }
    if (
      Object.keys(record).sort().join(",") !==
        "artifactDigest,entryId,payloadDigest,platform,schemaVersion" ||
      record.schemaVersion !== 1 ||
      record.platform !== sourceEntry.platform ||
      record.entryId !== sourceEntry.entryId ||
      record.payloadDigest !== sourceEntry.manifest.payload.integrity.digest ||
      record.artifactDigest !== sourceEntry.manifest.artifact.integrity.digest
    ) {
      return "Restore metadata does not match its compressed source entry";
    }
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Restore metadata is invalid";
  } finally {
    fs.closeSync(descriptor);
  }
};

const readRestores = (
  paths: CachePaths,
  entries: CatalogEntry[],
  issues: CatalogIssue[]
): CatalogRestore[] => {
  if (!pathExists(paths.restoresRoot)) return [];
  try {
    assertManagedDirectory(paths.providerRoot, paths.restoresRoot);
  } catch (error) {
    issues.push({
      code: "unsafe-restores-root",
      path: paths.restoresRoot,
      message: error instanceof Error ? error.message : "Unsafe restores root",
      severity: "error",
    });
    return [];
  }

  const restores: CatalogRestore[] = [];
  for (const name of fs.readdirSync(paths.restoresRoot).sort()) {
    if (name === "staging") continue;
    const platformRoot = path.join(paths.restoresRoot, name);
    if (name !== "android" && name !== "ios") {
      const stats = fs.lstatSync(platformRoot);
      const restore: CatalogRestore = {
        platform: null,
        entryId: null,
        directory: platformRoot,
        sizeBytes: calculatePathSize(platformRoot),
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        sourceEntry: null,
        metadataValid: false,
        metadataIssue:
          "Unexpected data exists directly under the restores root",
      };
      restores.push(restore);
      issues.push({
        code: "invalid-restore",
        path: platformRoot,
        message: restore.metadataIssue!,
        severity: "warning",
      });
      continue;
    }
    try {
      assertManagedDirectory(paths.providerRoot, platformRoot);
      for (const entryId of fs.readdirSync(platformRoot).sort()) {
        const directory = path.join(platformRoot, entryId);
        const stats = fs.lstatSync(directory);
        const sourceEntry = ENTRY_ID_PATTERN.test(entryId)
          ? entries.find(
              (entry) => entry.platform === name && entry.entryId === entryId
            ) ?? null
          : null;
        let metadataIssue: string | null = null;
        try {
          assertManagedDirectory(paths.providerRoot, directory);
          metadataIssue = sourceEntry
            ? readRestoreMetadata(directory, sourceEntry)
            : "Restore has no matching compressed source entry";
        } catch (error) {
          metadataIssue =
            error instanceof Error ? error.message : "Restore is unsafe";
        }
        const restore: CatalogRestore = {
          platform: name,
          entryId: ENTRY_ID_PATTERN.test(entryId) ? entryId : null,
          directory,
          sizeBytes: calculatePathSize(directory),
          modifiedAt: new Date(stats.mtimeMs).toISOString(),
          sourceEntry,
          metadataValid: metadataIssue === null,
          metadataIssue,
        };
        restores.push(restore);
        if (metadataIssue) {
          issues.push({
            code: sourceEntry ? "invalid-restore" : "orphan-restore",
            path: directory,
            message: metadataIssue,
            severity: "warning",
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "unsafe-restores-root",
        path: platformRoot,
        message:
          error instanceof Error
            ? error.message
            : "Unsafe platform restore root",
        severity: "error",
      });
    }
  }
  return restores;
};

const readInvalidProtection = (
  paths: CachePaths,
  entryId: string | null
): string | null => {
  if (!entryId) {
    return null;
  }
  try {
    return (
      readAccessRecord(paths.accessRoot, entryId, paths.providerRoot)
        ?.protectedUntil ?? null
    );
  } catch {
    return null;
  }
};

const addInvalidEntry = (
  paths: CachePaths,
  invalidEntries: CacheCatalog["invalidEntries"],
  platform: CachePlatform | null,
  entryId: string | null,
  directory: string
): void => {
  const stats = fs.lstatSync(directory);
  invalidEntries.push({
    platform,
    entryId,
    directory,
    sizeBytes: calculatePathSize(directory),
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    protectedUntil: readInvalidProtection(paths, entryId),
  });
};

const safeDirectorySize = (
  providerRoot: string,
  candidate: string,
  issues: CatalogIssue[],
  code: string
): number => {
  if (!pathExists(candidate)) {
    return 0;
  }
  try {
    assertManagedDirectory(providerRoot, candidate);
    return calculatePathSize(candidate);
  } catch (error) {
    issues.push({
      code,
      path: candidate,
      message: error instanceof Error ? error.message : "unsafe cache path",
      severity: "error",
    });
    return 0;
  }
};

const readEntry = (
  paths: CachePaths,
  platform: CachePlatform,
  entryId: string,
  issues: CatalogIssue[],
  invalidEntries: CacheCatalog["invalidEntries"]
): CatalogEntry | null => {
  const directory = path.join(paths.entriesRoot, platform, entryId);
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    issues.push({
      code: "unexpected-entry-name",
      path: directory,
      message: "Entry directory name is not a cache entry id",
      severity: "warning",
    });
    addInvalidEntry(paths, invalidEntries, platform, null, directory);
    return null;
  }

  try {
    assertManagedDirectory(paths.providerRoot, directory);
    const manifest = readManifest(directory);
    if (
      manifest.entryId !== entryId ||
      manifest.platform !== platform ||
      !Number.isFinite(Date.parse(manifest.createdAt))
    ) {
      throw new Error("Manifest identity or creation time is invalid");
    }

    let lastAccessedAt = manifest.createdAt;
    let protectedUntil: string | null = null;
    let accessIssue: string | null = null;
    try {
      const access = readAccessRecord(
        paths.accessRoot,
        entryId,
        paths.providerRoot
      );
      if (access) {
        if (access.platform !== platform) {
          throw new Error("Access metadata platform does not match the entry");
        }
        lastAccessedAt = access.lastAccessedAt;
        protectedUntil = access.protectedUntil;
      }
    } catch (error) {
      accessIssue =
        error instanceof Error ? error.message : "Malformed access metadata";
      issues.push({
        code: "invalid-access-metadata",
        path: path.join(paths.accessRoot, `${entryId}.json`),
        message: accessIssue,
        severity: "warning",
      });
    }

    const restoreDirectory = path.join(paths.restoresRoot, platform, entryId);
    let restoreBytes = 0;
    if (pathExists(restoreDirectory)) {
      try {
        assertManagedDirectory(paths.providerRoot, restoreDirectory);
        restoreBytes = calculatePathSize(restoreDirectory);
      } catch {
        // Detailed restore validation runs after all source entries are known.
      }
    }
    const encoding = manifest.schemaVersion === 2 ? "zstd" : "none";
    const entryBytes = calculatePathSize(directory);
    const grossCompressionSavedBytes =
      manifest.schemaVersion === 2
        ? manifest.payload.schema1EquivalentBytes - entryBytes
        : 0;
    if (
      !Number.isSafeInteger(grossCompressionSavedBytes) ||
      grossCompressionSavedBytes < 0
    ) {
      throw new Error(
        "Compressed cache metadata cannot claim less storage than the committed entry"
      );
    }
    return {
      platform,
      entryId,
      fingerprintHash: manifest.fingerprintHash,
      directory,
      sizeBytes: entryBytes,
      createdAt: manifest.createdAt,
      lastAccessedAt,
      protectedUntil,
      manifest,
      accessIssue,
      encoding,
      logicalArtifactBytes: manifest.artifact.sizeBytes,
      payloadBytes:
        manifest.schemaVersion === 2 ? manifest.payload.sizeBytes : null,
      compressionRatio:
        manifest.schemaVersion === 2 && manifest.artifact.sizeBytes > 0
          ? manifest.payload.sizeBytes / manifest.artifact.sizeBytes
          : null,
      grossCompressionSavedBytes,
      restoreBytes,
    };
  } catch (error) {
    issues.push({
      code: "invalid-entry",
      path: directory,
      message: error instanceof Error ? error.message : "Invalid cache entry",
      severity: "error",
    });
    try {
      addInvalidEntry(
        paths,
        invalidEntries,
        platform,
        ENTRY_ID_PATTERN.test(entryId) ? entryId : null,
        directory
      );
    } catch {
      // A concurrently removed entry has no remaining storage to report.
    }
    return null;
  }
};

const readEntries = (
  paths: CachePaths,
  issues: CatalogIssue[],
  invalidEntries: CacheCatalog["invalidEntries"]
): CatalogEntry[] => {
  if (!pathExists(paths.entriesRoot)) {
    return [];
  }
  try {
    assertManagedDirectory(paths.providerRoot, paths.entriesRoot);
  } catch (error) {
    issues.push({
      code: "unsafe-entries-root",
      path: paths.entriesRoot,
      message: error instanceof Error ? error.message : "Unsafe entries root",
      severity: "error",
    });
    return [];
  }

  const entries: CatalogEntry[] = [];
  for (const name of fs.readdirSync(paths.entriesRoot).sort()) {
    if (name === "android" || name === "ios") {
      continue;
    }
    const candidate = path.join(paths.entriesRoot, name);
    issues.push({
      code: "unexpected-entry-layout",
      path: candidate,
      message: "Unexpected data exists directly under the entries root",
      severity: "warning",
    });
    try {
      addInvalidEntry(paths, invalidEntries, null, null, candidate);
    } catch (error) {
      issues.push({
        code: "unreadable-invalid-entry",
        path: candidate,
        message:
          error instanceof Error
            ? error.message
            : "Invalid entry is unreadable",
        severity: "error",
      });
    }
  }
  for (const platform of ["android", "ios"] as const) {
    const platformRoot = path.join(paths.entriesRoot, platform);
    if (!pathExists(platformRoot)) {
      continue;
    }
    try {
      assertManagedDirectory(paths.providerRoot, platformRoot);
      for (const entryId of fs.readdirSync(platformRoot).sort()) {
        const entry = readEntry(
          paths,
          platform,
          entryId,
          issues,
          invalidEntries
        );
        if (entry) {
          entries.push(entry);
        }
      }
    } catch (error) {
      issues.push({
        code: "unsafe-platform-root",
        path: platformRoot,
        message:
          error instanceof Error ? error.message : "Unsafe platform root",
        severity: "error",
      });
      try {
        addInvalidEntry(paths, invalidEntries, platform, null, platformRoot);
      } catch {
        // The issue above already records the unsafe or unreadable platform.
      }
    }
  }

  return entries.sort((left, right) =>
    `${left.platform}:${left.entryId}`.localeCompare(
      `${right.platform}:${right.entryId}`
    )
  );
};

const readLegacyEntries = (paths: CachePaths) => {
  if (!pathExists(paths.cacheRoot)) {
    return [];
  }
  const entries: CacheCatalog["legacyEntries"] = [];
  for (const name of fs.readdirSync(paths.cacheRoot).sort()) {
    const match = /^(android|ios)_.+\.(apk|app)$/.exec(name);
    if (!match) {
      continue;
    }
    const candidate = path.join(paths.cacheRoot, name);
    const stats = fs.lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      continue;
    }
    entries.push({
      platform: match[1] as CachePlatform,
      path: candidate,
      sizeBytes: calculatePathSize(candidate),
    });
  }
  return entries;
};

export const inventoryCache = (projectRoot: string): CacheCatalog => {
  const managedProjectRoot = fs.realpathSync(projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  const issues: CatalogIssue[] = [];

  if (!pathExists(paths.providerRoot)) {
    const legacyEntries = readLegacyEntries(paths);
    const legacyBytes = legacyEntries.reduce(
      (total, entry) => total + entry.sizeBytes,
      0
    );
    return {
      projectRoot: managedProjectRoot,
      paths,
      entries: [],
      restores: [],
      invalidEntries: [],
      issues: [],
      telemetry: { eventCount: 0, invalidEventCount: 0 },
      legacyEntries,
      usage: {
        entriesBytes: 0,
        invalidEntriesBytes: 0,
        stagingBytes: 0,
        quarantineBytes: 0,
        trashBytes: 0,
        accessBytes: 0,
        stateBytes: 0,
        locksBytes: 0,
        eventsBytes: 0,
        restoreCommittedBytes: 0,
        restoreStagingBytes: 0,
        otherBytes: 0,
        legacyBytes,
        managedBytes: 0,
        totalBytes: legacyBytes,
      },
    };
  }

  try {
    assertProviderRoot(managedProjectRoot, paths.providerRoot);
  } catch (error) {
    return {
      projectRoot: managedProjectRoot,
      paths,
      entries: [],
      restores: [],
      invalidEntries: [],
      issues: [
        {
          code: "unsafe-provider-root",
          path: paths.providerRoot,
          message:
            error instanceof Error ? error.message : "Unsafe provider root",
          severity: "error",
        },
      ],
      telemetry: { eventCount: 0, invalidEventCount: 0 },
      legacyEntries: [],
      usage: {
        entriesBytes: 0,
        invalidEntriesBytes: 0,
        stagingBytes: 0,
        quarantineBytes: 0,
        trashBytes: 0,
        accessBytes: 0,
        stateBytes: 0,
        locksBytes: 0,
        eventsBytes: 0,
        restoreCommittedBytes: 0,
        restoreStagingBytes: 0,
        otherBytes: 0,
        legacyBytes: 0,
        managedBytes: 0,
        totalBytes: 0,
      },
    };
  }

  const invalidEntries: CacheCatalog["invalidEntries"] = [];
  const entries = readEntries(paths, issues, invalidEntries);
  const restores = readRestores(paths, entries, issues);
  const legacyEntries = readLegacyEntries(paths);
  const entriesBytes = entries.reduce(
    (total, entry) => total + entry.sizeBytes,
    0
  );
  const entriesStorageBytes = safeDirectorySize(
    paths.providerRoot,
    paths.entriesRoot,
    issues,
    "unsafe-entries-root"
  );
  const invalidEntriesBytes = Math.max(0, entriesStorageBytes - entriesBytes);
  const stagingBytes = safeDirectorySize(
    paths.providerRoot,
    paths.stagingRoot,
    issues,
    "unsafe-staging-root"
  );
  const quarantineBytes = safeDirectorySize(
    paths.providerRoot,
    paths.quarantineRoot,
    issues,
    "unsafe-quarantine-root"
  );
  const trashBytes = safeDirectorySize(
    paths.providerRoot,
    paths.trashRoot,
    issues,
    "unsafe-trash-root"
  );
  const accessBytes = safeDirectorySize(
    paths.providerRoot,
    paths.accessRoot,
    issues,
    "unsafe-access-root"
  );
  const stateBytes = safeDirectorySize(
    paths.providerRoot,
    paths.stateRoot,
    issues,
    "unsafe-state-root"
  );
  const locksBytes = safeDirectorySize(
    paths.providerRoot,
    paths.locksRoot,
    issues,
    "unsafe-locks-root"
  );
  const eventsBytes = safeDirectorySize(
    paths.providerRoot,
    paths.eventsRoot,
    issues,
    "unsafe-events-root"
  );
  const restoreStagingBytes = safeDirectorySize(
    paths.providerRoot,
    paths.restoreStagingRoot,
    issues,
    "unsafe-restore-staging-root"
  );
  const restoreCommittedBytes = Math.max(
    0,
    safeDirectorySize(
      paths.providerRoot,
      paths.restoresRoot,
      issues,
      "unsafe-restores-root"
    ) - restoreStagingBytes
  );
  let eventCount = 0;
  let invalidEventCount = 0;
  try {
    const eventScan = scanResolveEvents(paths.eventsRoot);
    eventCount = eventScan.events.length;
    invalidEventCount = eventScan.invalid.length;
    for (const invalid of eventScan.invalid) {
      issues.push({
        code: "invalid-resolve-event",
        path: invalid.filePath,
        message: invalid.reason,
        severity: "warning",
      });
    }
  } catch (error) {
    if (pathExists(paths.eventsRoot)) {
      issues.push({
        code: "unreadable-events-root",
        path: paths.eventsRoot,
        message:
          error instanceof Error ? error.message : "Events root is unreadable",
        severity: "error",
      });
    }
  }
  const legacyBytes = legacyEntries.reduce(
    (total, entry) => total + entry.sizeBytes,
    0
  );
  const providerBytes = calculatePathSize(paths.providerRoot);
  const categorizedProviderBytes =
    entriesStorageBytes +
    stagingBytes +
    quarantineBytes +
    trashBytes +
    accessBytes +
    stateBytes +
    locksBytes +
    eventsBytes +
    restoreCommittedBytes +
    restoreStagingBytes;
  const otherBytes = Math.max(0, providerBytes - categorizedProviderBytes);
  const managedBytes =
    entriesStorageBytes +
    stagingBytes +
    restoreCommittedBytes +
    restoreStagingBytes +
    quarantineBytes +
    trashBytes;

  return {
    projectRoot: managedProjectRoot,
    paths,
    entries,
    restores,
    invalidEntries,
    issues,
    telemetry: { eventCount, invalidEventCount },
    legacyEntries,
    usage: {
      entriesBytes,
      invalidEntriesBytes,
      stagingBytes,
      quarantineBytes,
      trashBytes,
      accessBytes,
      stateBytes,
      locksBytes,
      eventsBytes,
      restoreCommittedBytes,
      restoreStagingBytes,
      otherBytes,
      legacyBytes,
      managedBytes,
      totalBytes: providerBytes + legacyBytes,
    },
  };
};
