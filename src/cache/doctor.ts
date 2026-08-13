import * as fs from "fs";
import * as path from "path";

import { extractAppTree } from "./app-tree";
import { checkAvailableSpace, getCompressionCapacity } from "./capacity";
import { inventoryCache, type CatalogIssue } from "./catalog";
import {
  assertManagedDirectory,
  ensureManagedDirectory,
  pathExists,
} from "./filesystem";
import { readInsight } from "./insight";
import { inspectArtifact } from "./integrity";
import type { CompressedCacheManifest } from "./manifest";
import { getArtifactName } from "./paths";
import { validateEntry } from "./validation";
import { discoverZstdCodec, type ZstdCodec } from "./zstd";

export type DoctorReport = {
  healthy: boolean;
  deep: boolean;
  checkedEntries: number;
  checkedRestores: number;
  compression: {
    grossSavedBytes: number;
    restoreBytes: number;
    netSavedBytes: number;
  };
  issues: CatalogIssue[];
};

const getCompressionSummary = (
  catalog: ReturnType<typeof inventoryCache>
): DoctorReport["compression"] => {
  let grossSavedBytes = 0;
  for (const entry of catalog.entries) {
    grossSavedBytes += entry.grossCompressionSavedBytes;
    if (!Number.isSafeInteger(grossSavedBytes)) {
      throw new Error("Compression savings exceed the supported byte range");
    }
  }
  return {
    grossSavedBytes,
    restoreBytes: catalog.usage.restoreCommittedBytes,
    netSavedBytes: grossSavedBytes - catalog.usage.restoreCommittedBytes,
  };
};

const validateExistingRestore = (
  restore: ReturnType<typeof inventoryCache>["restores"][number]
): string | null => {
  if (!restore.metadataValid || !restore.sourceEntry) {
    return restore.metadataIssue ?? "Restore is invalid";
  }
  try {
    const manifest = restore.sourceEntry.manifest;
    const artifact = inspectArtifact(
      path.join(
        restore.directory,
        getArtifactName(restore.sourceEntry.platform)
      ),
      restore.sourceEntry.platform,
      {
        sizeBytes: manifest.artifact.sizeBytes,
        fileCount: manifest.artifact.fileCount,
      }
    );
    return artifact.algorithm === manifest.artifact.integrity.algorithm &&
      artifact.digest === manifest.artifact.integrity.digest &&
      artifact.sizeBytes === manifest.artifact.sizeBytes &&
      artifact.fileCount === manifest.artifact.fileCount
      ? null
      : "Restore artifact integrity mismatch";
  } catch (error) {
    return error instanceof Error ? error.message : "Restore is unreadable";
  }
};

export const doctorCache = (projectRoot: string): DoctorReport => {
  const catalog = inventoryCache(projectRoot);
  const issues = [...catalog.issues];

  for (const entry of catalog.entries) {
    const validation = validateEntry(
      entry.directory,
      catalog.paths.providerRoot,
      entry.platform,
      entry.fingerprintHash,
      entry.entryId
    );
    if (!validation.valid) {
      issues.push({
        code: "integrity-mismatch",
        path: entry.directory,
        message: validation.reason,
        severity: "error",
      });
    }
    try {
      const insight = readInsight(entry.directory);
      if (
        insight &&
        (insight.entryId !== entry.entryId ||
          insight.platform !== entry.platform ||
          insight.fingerprintHash !== entry.fingerprintHash)
      ) {
        throw new Error("Cache insight identity does not match its entry");
      }
    } catch (error) {
      issues.push({
        code: "invalid-cache-insight",
        path: `${entry.directory}/insight.json`,
        message:
          error instanceof Error ? error.message : "Cache insight is invalid",
        severity: "warning",
      });
    }
  }

  for (const restore of catalog.restores) {
    if (!restore.metadataValid) continue;
    const reason = validateExistingRestore(restore);
    if (reason) {
      issues.push({
        code: "restore-integrity-mismatch",
        path: restore.directory,
        message: reason,
        severity: "error",
      });
    }
  }

  if (fs.existsSync(catalog.paths.accessRoot)) {
    try {
      assertManagedDirectory(
        catalog.paths.providerRoot,
        catalog.paths.accessRoot
      );
      const knownEntries = new Set(
        catalog.entries.map((entry) => entry.entryId)
      );
      for (const name of fs.readdirSync(catalog.paths.accessRoot)) {
        const match = /^([a-f0-9]{64})\.json$/.exec(name);
        if (match && !knownEntries.has(match[1]!)) {
          issues.push({
            code: "orphan-access-metadata",
            path: `${catalog.paths.accessRoot}/${name}`,
            message: "Access metadata has no matching cache entry",
            severity: "warning",
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "unreadable-access-root",
        path: catalog.paths.accessRoot,
        message:
          error instanceof Error ? error.message : "Access root is unreadable",
        severity: "error",
      });
    }
  }

  return {
    healthy: issues.length === 0,
    deep: false,
    checkedEntries: catalog.entries.length,
    checkedRestores: catalog.restores.length,
    compression: getCompressionSummary(catalog),
    issues,
  };
};

const deeplyValidateEntry = async (
  catalog: ReturnType<typeof inventoryCache>,
  entry: ReturnType<typeof inventoryCache>["entries"][number],
  manifest: CompressedCacheManifest,
  codec: ZstdCodec
): Promise<string | null> => {
  const capacity = getCompressionCapacity({
    platform: entry.platform,
    logicalSizeBytes: manifest.artifact.sizeBytes,
    snapshotApparentBytes: manifest.artifact.sizeBytes,
    fileCount: manifest.artifact.fileCount,
  });
  if (
    checkAvailableSpace(
      catalog.paths.restoreStagingRoot,
      capacity.restoreRequiredBytes
    ).status === "insufficient"
  ) {
    return "Insufficient space for deep restore validation";
  }
  ensureManagedDirectory(
    catalog.paths.providerRoot,
    catalog.paths.restoresRoot
  );
  ensureManagedDirectory(
    catalog.paths.providerRoot,
    catalog.paths.restoreStagingRoot
  );
  const staging = fs.mkdtempSync(
    path.join(catalog.paths.restoreStagingRoot, `${entry.entryId}-doctor-`)
  );
  const decoded = path.join(staging, "decoded.stream");
  const artifactPath = path.join(staging, getArtifactName(entry.platform));
  try {
    await codec.decode(
      path.join(entry.directory, manifest.payload.relativePath),
      decoded,
      {
        maxOutputBytes: capacity.archiveBound,
        logicalSizeBytes: Math.max(1, manifest.artifact.sizeBytes),
      }
    );
    if (entry.platform === "ios") {
      await extractAppTree(decoded, artifactPath, {
        sizeBytes: manifest.artifact.sizeBytes,
        fileCount: manifest.artifact.fileCount,
        maxArchiveBytes: capacity.archiveBound,
      });
    } else {
      fs.renameSync(decoded, artifactPath);
    }
    const artifact = inspectArtifact(artifactPath, entry.platform, {
      sizeBytes: manifest.artifact.sizeBytes,
      fileCount: manifest.artifact.fileCount,
    });
    return artifact.algorithm === manifest.artifact.integrity.algorithm &&
      artifact.digest === manifest.artifact.integrity.digest &&
      artifact.sizeBytes === manifest.artifact.sizeBytes &&
      artifact.fileCount === manifest.artifact.fileCount
      ? null
      : "Deep restore integrity mismatch";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Deep restore validation failed";
  } finally {
    if (pathExists(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
};

export const doctorCacheDeep = async (
  projectRoot: string,
  options: { codec?: ZstdCodec | null } = {}
): Promise<DoctorReport> => {
  const report = doctorCache(projectRoot);
  const catalog = inventoryCache(projectRoot);
  const compressed = catalog.entries.filter(
    (entry) => entry.manifest.schemaVersion === 2
  );
  if (compressed.length === 0) return { ...report, deep: true };
  const codec =
    options.codec === undefined ? discoverZstdCodec() : options.codec;
  if (!codec) {
    return {
      ...report,
      healthy: false,
      deep: true,
      issues: [
        ...report.issues,
        {
          code: "zstd-unavailable",
          path: catalog.paths.providerRoot,
          message:
            "Deep validation could not prove compressed entries because zstd is unavailable",
          severity: "warning",
        },
      ],
    };
  }
  const issues = [...report.issues];
  for (const entry of compressed) {
    if (entry.manifest.schemaVersion !== 2) continue;
    const reason = await deeplyValidateEntry(
      catalog,
      entry,
      entry.manifest,
      codec
    );
    if (reason) {
      issues.push({
        code: "deep-restore-failed",
        path: entry.directory,
        message: reason,
        severity: "error",
      });
    }
  }
  return { ...report, healthy: issues.length === 0, deep: true, issues };
};
