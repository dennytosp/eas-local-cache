import * as fs from "fs";

import { inventoryCache, type CatalogIssue } from "./catalog";
import { assertManagedDirectory } from "./filesystem";
import { readInsight } from "./insight";
import { validateEntry } from "./validation";

export type DoctorReport = {
  healthy: boolean;
  checkedEntries: number;
  issues: CatalogIssue[];
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
    checkedEntries: catalog.entries.length,
    issues,
  };
};
