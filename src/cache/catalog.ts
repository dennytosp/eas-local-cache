import * as fs from "fs";
import * as path from "path";

import { readAccessRecord } from "./access";
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
  invalidEntries: Array<{
    platform: CachePlatform | null;
    entryId: string | null;
    directory: string;
    sizeBytes: number;
    modifiedAt: string;
    protectedUntil: string | null;
  }>;
  issues: CatalogIssue[];
  usage: {
    entriesBytes: number;
    invalidEntriesBytes: number;
    stagingBytes: number;
    quarantineBytes: number;
    trashBytes: number;
    accessBytes: number;
    stateBytes: number;
    locksBytes: number;
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

    return {
      platform,
      entryId,
      fingerprintHash: manifest.fingerprintHash,
      directory,
      sizeBytes: calculatePathSize(directory),
      createdAt: manifest.createdAt,
      lastAccessedAt,
      protectedUntil,
      manifest,
      accessIssue,
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
      invalidEntries: [],
      issues: [],
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
        otherBytes: 0,
        legacyBytes: 0,
        managedBytes: 0,
        totalBytes: 0,
      },
    };
  }

  const invalidEntries: CacheCatalog["invalidEntries"] = [];
  const entries = readEntries(paths, issues, invalidEntries);
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
    locksBytes;
  const otherBytes = Math.max(0, providerBytes - categorizedProviderBytes);
  const managedBytes =
    entriesStorageBytes + stagingBytes + quarantineBytes + trashBytes;

  return {
    projectRoot: managedProjectRoot,
    paths,
    entries,
    invalidEntries,
    issues,
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
      otherBytes,
      legacyBytes,
      managedBytes,
      totalBytes: providerBytes + legacyBytes,
    },
  };
};
