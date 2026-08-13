import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { touchAccessRecord } from "../cache/access";
import { extractAppTree } from "../cache/app-tree";
import {
  ensureManagedDirectory,
  ensureProviderRoot,
  pathExists,
} from "../cache/filesystem";
import {
  acquireEntryLock,
  getEntryLockDirectory,
  releaseEntryLock,
  type EntryLock,
} from "../cache/lock";
import {
  getArtifactName,
  getCachePaths,
  getEntryDirectory,
  getRestoreDirectory,
  type CachePlatform,
} from "../cache/paths";
import { validateEntry } from "../cache/validation";
import { inspectWirePackage, type InspectedWirePackage } from "./wire";

export type WireImportResult = {
  status: "imported" | "existing";
  sameGeneration: boolean;
  entryDirectory: string;
  manifestSha256: string;
};

const writeExclusiveFile = (
  filePath: string,
  contents: Buffer,
  mode = 0o600
): void => {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    mode
  );
  try {
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.writeSync(
        descriptor,
        contents,
        offset,
        contents.length - offset
      );
      if (count === 0) throw new Error("Unable to make import write progress");
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const copyWireBody = (
  inspected: InspectedWirePackage,
  destination: string
): void => {
  const pathStats = fs.lstatSync(inspected.packagePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error("Wire package must remain a regular file during import");
  }
  const source = fs.openSync(
    inspected.packagePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  const output = fs.openSync(
    destination,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600
  );
  let complete = false;
  try {
    const openedStats = fs.fstatSync(source);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size !== inspected.totalBytes
    ) {
      throw new Error("Wire package changed before import");
    }
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(1024 * 1024, inspected.header.body.sizeBytes)
    );
    let copied = 0;
    while (copied < inspected.header.body.sizeBytes) {
      const count = fs.readSync(
        source,
        buffer,
        0,
        Math.min(buffer.length, inspected.header.body.sizeBytes - copied),
        inspected.bodyOffset + copied
      );
      if (count === 0) throw new Error("Wire body is truncated during import");
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const writeCount = fs.writeSync(
          output,
          chunk,
          written,
          chunk.length - written
        );
        if (writeCount === 0) {
          throw new Error("Unable to make import write progress");
        }
        written += writeCount;
      }
      copied += count;
    }
    if (hash.digest("hex") !== inspected.header.body.sha256) {
      throw new Error("Wire body changed between inspection and import");
    }
    const finalStats = fs.fstatSync(source);
    if (
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size
    ) {
      throw new Error("Wire package changed during import");
    }
    fs.fsyncSync(output);
    complete = true;
  } finally {
    fs.closeSync(output);
    fs.closeSync(source);
    if (!complete) fs.rmSync(destination, { force: true });
  }
};

const assertHeldTransferLock = (
  locksRoot: string,
  entryId: string,
  lock: EntryLock
): void => {
  if (lock.directory !== getEntryLockDirectory(locksRoot, entryId)) {
    throw new Error("Provided transfer lock does not match the imported entry");
  }
  const stats = fs.lstatSync(lock.directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Provided transfer lock is not an active lock directory");
  }
  const ownerPath = path.join(lock.directory, "owner.json");
  const descriptor = fs.openSync(
    ownerPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const ownerStats = fs.fstatSync(descriptor);
    if (
      !ownerStats.isFile() ||
      ownerStats.size <= 0 ||
      ownerStats.size > 4096
    ) {
      throw new Error("Provided transfer lock has invalid ownership metadata");
    }
    const owner = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (
      typeof owner !== "object" ||
      owner === null ||
      !("token" in owner) ||
      owner.token !== lock.token
    ) {
      throw new Error("Provided transfer lock is not owned by this caller");
    }
  } finally {
    fs.closeSync(descriptor);
  }
};

const readManifestDigest = (entryDirectory: string): string | null => {
  try {
    const descriptor = fs.openSync(
      path.join(entryDirectory, "manifest.json"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || stats.size <= 0 || stats.size > 64 * 1024) {
        return null;
      }
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stats.size));
      let offset = 0;
      while (offset < stats.size) {
        const count = fs.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, stats.size - offset),
          offset
        );
        if (count === 0) return null;
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      return hash.digest("hex");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
};

const quarantineInvalidEntry = (input: {
  providerRoot: string;
  quarantineRoot: string;
  entryDirectory: string;
  restoreDirectory: string;
  platform: CachePlatform;
  entryId: string;
  reason: string;
}): void => {
  if (!pathExists(input.entryDirectory)) return;
  ensureManagedDirectory(input.providerRoot, input.quarantineRoot);
  const destination = path.join(
    input.quarantineRoot,
    `${input.platform}-${input.entryId}-lan-import-${crypto.randomUUID()}`
  );
  let restoreDestination: string | null = null;
  if (pathExists(input.restoreDirectory)) {
    restoreDestination = `${destination}-restore`;
    fs.renameSync(input.restoreDirectory, restoreDestination);
  }
  try {
    fs.renameSync(input.entryDirectory, destination);
  } catch (error) {
    if (
      restoreDestination &&
      pathExists(restoreDestination) &&
      !pathExists(input.restoreDirectory)
    ) {
      fs.renameSync(restoreDestination, input.restoreDirectory);
    }
    throw error;
  }
  try {
    fs.writeFileSync(
      `${destination}.json`,
      `${JSON.stringify({
        quarantinedAt: new Date().toISOString(),
        reason: input.reason,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch {
    // Quarantine metadata is diagnostic and must not undo safe removal.
  }
};

const existingResult = (input: {
  entryDirectory: string;
  expectedManifestSha256: string;
}): WireImportResult => {
  const manifestSha256 = readManifestDigest(input.entryDirectory);
  return {
    status: "existing",
    sameGeneration: manifestSha256 === input.expectedManifestSha256,
    entryDirectory: input.entryDirectory,
    manifestSha256: manifestSha256 ?? "",
  };
};

export const importWirePackage = async (input: {
  projectRoot: string;
  packagePath: string;
  expectedPlatform: CachePlatform;
  expectedEntryId: string;
  maxWaitMs?: number;
  transferLock?: EntryLock;
  replaceCompressedUnavailable?: {
    payloadDigest: string;
  };
}): Promise<WireImportResult> => {
  const inspected = inspectWirePackage({
    packagePath: input.packagePath,
    expectedPlatform: input.expectedPlatform,
    expectedEntryId: input.expectedEntryId,
  });
  const managedProjectRoot = fs.realpathSync(input.projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  ensureProviderRoot(managedProjectRoot, paths.providerRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferLocksRoot);
  ensureManagedDirectory(paths.providerRoot, paths.transferStagingRoot);
  if (process.platform !== "win32") {
    fs.chmodSync(paths.transferLocksRoot, 0o700);
    fs.chmodSync(paths.transferStagingRoot, 0o700);
  }
  if (input.transferLock) {
    assertHeldTransferLock(
      paths.transferLocksRoot,
      inspected.header.entryId,
      input.transferLock
    );
  }
  const transferLock =
    input.transferLock ??
    (await acquireEntryLock(paths.transferLocksRoot, inspected.header.entryId, {
      maxWaitMs: input.maxWaitMs ?? 45_000,
      retryIntervalMs: 50,
    }));
  if (!transferLock) {
    throw new Error("Timed out waiting to import the LAN cache entry");
  }

  const entryDirectory = getEntryDirectory(
    paths,
    inspected.header.platform,
    inspected.header.entryId
  );
  const mayReplaceCompressed = (
    validation: Extract<ReturnType<typeof validateEntry>, { valid: true }>
  ): boolean =>
    inspected.manifest.schemaVersion === 1 &&
    validation.manifest.schemaVersion === 2 &&
    input.replaceCompressedUnavailable?.payloadDigest ===
      validation.manifest.payload.integrity.digest;
  let stagingDirectory: string | null = null;
  try {
    if (pathExists(entryDirectory)) {
      const existing = validateEntry(
        entryDirectory,
        paths.providerRoot,
        inspected.header.platform,
        inspected.manifest.fingerprintHash,
        inspected.header.entryId
      );
      if (existing.valid && !mayReplaceCompressed(existing)) {
        return existingResult({
          entryDirectory,
          expectedManifestSha256: inspected.header.manifest.sha256,
        });
      }
    }

    stagingDirectory = fs.mkdtempSync(
      path.join(paths.transferStagingRoot, `${inspected.header.entryId}-`)
    );
    const artifactName = getArtifactName(inspected.header.platform);
    if (inspected.header.body.kind === "elc-app-tree-v1") {
      const archivePath = path.join(stagingDirectory, "artifact.app.elcapp1");
      copyWireBody(inspected, archivePath);
      try {
        await extractAppTree(
          archivePath,
          path.join(stagingDirectory, artifactName),
          {
            sizeBytes: inspected.manifest.artifact.sizeBytes,
            fileCount: inspected.manifest.artifact.fileCount,
            maxArchiveBytes: inspected.header.body.sizeBytes,
          }
        );
      } finally {
        fs.rmSync(archivePath, { force: true });
      }
    } else {
      const bodyName =
        inspected.header.body.kind === "zstd-v1" &&
        inspected.manifest.schemaVersion === 2
          ? inspected.manifest.payload.relativePath
          : artifactName;
      copyWireBody(inspected, path.join(stagingDirectory, bodyName));
    }
    writeExclusiveFile(
      path.join(stagingDirectory, "manifest.json"),
      inspected.manifestBytes
    );

    const stagedValidation = validateEntry(
      stagingDirectory,
      paths.providerRoot,
      inspected.header.platform,
      inspected.manifest.fingerprintHash,
      inspected.header.entryId
    );
    if (!stagedValidation.valid) {
      throw new Error(
        `Imported cache entry failed validation: ${stagedValidation.reason}`
      );
    }

    ensureManagedDirectory(paths.providerRoot, paths.locksRoot);
    ensureManagedDirectory(paths.providerRoot, path.dirname(entryDirectory));
    const entryLock = await acquireEntryLock(
      paths.locksRoot,
      inspected.header.entryId,
      { maxWaitMs: input.maxWaitMs ?? 30_000, retryIntervalMs: 50 }
    );
    if (!entryLock) {
      throw new Error("Timed out waiting to publish the LAN cache entry");
    }
    try {
      if (pathExists(entryDirectory)) {
        const existing = validateEntry(
          entryDirectory,
          paths.providerRoot,
          inspected.header.platform,
          inspected.manifest.fingerprintHash,
          inspected.header.entryId
        );
        if (existing.valid && !mayReplaceCompressed(existing)) {
          return existingResult({
            entryDirectory,
            expectedManifestSha256: inspected.header.manifest.sha256,
          });
        }
        if (!existing.valid) {
          quarantineInvalidEntry({
            providerRoot: paths.providerRoot,
            quarantineRoot: paths.quarantineRoot,
            entryDirectory,
            restoreDirectory: getRestoreDirectory(
              paths,
              inspected.header.platform,
              inspected.header.entryId
            ),
            platform: inspected.header.platform,
            entryId: inspected.header.entryId,
            reason: existing.reason,
          });
        } else {
          ensureManagedDirectory(paths.providerRoot, paths.trashRoot);
          const tombstone = path.join(
            paths.trashRoot,
            `${inspected.header.platform}-${
              inspected.header.entryId
            }-lan-replacement-${crypto.randomUUID()}`
          );
          const restoreDirectory = getRestoreDirectory(
            paths,
            inspected.header.platform,
            inspected.header.entryId
          );
          const restoreTombstone = `${tombstone}-restore`;
          let movedRestore = false;
          if (pathExists(restoreDirectory)) {
            fs.renameSync(restoreDirectory, restoreTombstone);
            movedRestore = true;
          }
          try {
            fs.renameSync(entryDirectory, tombstone);
            try {
              fs.renameSync(stagingDirectory, entryDirectory);
              stagingDirectory = null;
            } catch (error) {
              if (!pathExists(entryDirectory)) {
                fs.renameSync(tombstone, entryDirectory);
              }
              if (
                movedRestore &&
                pathExists(restoreTombstone) &&
                !pathExists(restoreDirectory)
              ) {
                fs.renameSync(restoreTombstone, restoreDirectory);
              }
              throw error;
            }
            try {
              fs.rmSync(tombstone, { recursive: true, force: true });
            } catch {
              // A committed immutable entry wins over best-effort trash cleanup.
            }
            if (movedRestore) {
              try {
                fs.rmSync(restoreTombstone, {
                  recursive: true,
                  force: true,
                });
              } catch {
                // Cleanup can remove the owned restore tombstone later.
              }
            }
          } catch (error) {
            if (
              movedRestore &&
              pathExists(restoreTombstone) &&
              !pathExists(restoreDirectory)
            ) {
              fs.renameSync(restoreTombstone, restoreDirectory);
            }
            throw error;
          }
        }
      }
      if (stagingDirectory) {
        fs.renameSync(stagingDirectory, entryDirectory);
        stagingDirectory = null;
      }
    } finally {
      releaseEntryLock(entryLock);
    }

    try {
      touchAccessRecord(
        paths.accessRoot,
        inspected.header.entryId,
        inspected.header.platform,
        { providerRoot: paths.providerRoot }
      );
    } catch {
      // Access metadata is diagnostic and never blocks an imported artifact.
    }
    return {
      status: "imported",
      sameGeneration: true,
      entryDirectory,
      manifestSha256: inspected.header.manifest.sha256,
    };
  } finally {
    if (stagingDirectory) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
    if (!input.transferLock) releaseEntryLock(transferLock);
  }
};
