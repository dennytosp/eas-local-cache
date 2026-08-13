import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { extractAppTree } from "./app-tree";
import { checkAvailableSpace, getCompressionCapacity } from "./capacity";
import {
  assertManagedDirectory,
  ensureManagedDirectory,
  pathExists,
} from "./filesystem";
import { inspectArtifact } from "./integrity";
import type { CompressedCacheManifest } from "./manifest";
import { getArtifactName, getRestoreDirectory, type CachePaths } from "./paths";
import { discoverZstdCodec, type ZstdCodec } from "./zstd";

const RESTORE_SCHEMA_VERSION = 1;
const MAX_RESTORE_MANIFEST_BYTES = 16 * 1024;

type RestoreManifest = {
  schemaVersion: 1;
  platform: "android" | "ios";
  entryId: string;
  payloadDigest: string;
  artifactDigest: string;
};

const restoreManifest = (
  manifest: CompressedCacheManifest
): RestoreManifest => ({
  schemaVersion: RESTORE_SCHEMA_VERSION,
  platform: manifest.platform,
  entryId: manifest.entryId,
  payloadDigest: manifest.payload.integrity.digest,
  artifactDigest: manifest.artifact.integrity.digest,
});

const readRestoreManifest = (directory: string): RestoreManifest => {
  const file = path.join(directory, "restore.json");
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.size <= 0 ||
      stats.size > MAX_RESTORE_MANIFEST_BYTES
    ) {
      throw new Error("Restore manifest must be a bounded regular file");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8")) as RestoreManifest;
  } finally {
    fs.closeSync(descriptor);
  }
};

const validateRestore = (
  directory: string,
  manifest: CompressedCacheManifest
): string | null => {
  try {
    const expected = restoreManifest(manifest);
    const actual = readRestoreManifest(directory);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return null;
    const artifactPath = path.join(
      directory,
      getArtifactName(manifest.platform)
    );
    const integrity = inspectArtifact(artifactPath, manifest.platform, {
      sizeBytes: manifest.artifact.sizeBytes,
      fileCount: manifest.artifact.fileCount,
    });
    return integrity.algorithm === manifest.artifact.integrity.algorithm &&
      integrity.digest === manifest.artifact.integrity.digest &&
      integrity.sizeBytes === manifest.artifact.sizeBytes &&
      integrity.fileCount === manifest.artifact.fileCount
      ? artifactPath
      : null;
  } catch {
    return null;
  }
};

export type RestoreUnavailableReason =
  | "zstd-unavailable"
  | "insufficient-space"
  | "codec-timeout"
  | "codec-inactive"
  | "codec-operational-failure"
  | "restore-storage-failure";

export type RestoreInvalidReason =
  | "decode-malformed"
  | "archive-invalid"
  | "integrity-mismatch";

export type RestoreResult =
  | { status: "restored"; artifactPath: string; created: boolean }
  | {
      status: "unavailable";
      reason: RestoreUnavailableReason;
      replaceable: boolean;
      detail?: string;
    }
  | { status: "invalid"; reason: RestoreInvalidReason; detail?: string };

type RestoreUnavailableResult = Extract<
  RestoreResult,
  { status: "unavailable" }
>;

const errorDetail = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const errorCode = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;

const nestedErrors = (error: unknown): unknown[] => {
  const errors: unknown[] = [];
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    errors.push(candidate);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }
  return errors;
};

const hasErrorCode = (error: unknown, codes: ReadonlySet<string>): boolean =>
  nestedErrors(error).some((candidate) => {
    const code = errorCode(candidate);
    return code !== null && codes.has(code);
  });

const hasErrorMessage = (error: unknown, fragment: string): boolean =>
  nestedErrors(error).some(
    (candidate) =>
      candidate instanceof Error && candidate.message.includes(fragment)
  );

const isToolUnavailableError = (error: unknown): boolean =>
  nestedErrors(error).some((candidate) => {
    const code = errorCode(candidate);
    if (code === null || !TOOL_UNAVAILABLE_CODES.has(code)) return false;
    if (typeof candidate !== "object" || candidate === null) return false;
    const syscall =
      "syscall" in candidate && typeof candidate.syscall === "string"
        ? candidate.syscall
        : "";
    return syscall === "spawn" || syscall.startsWith("spawn ");
  });

const TOOL_UNAVAILABLE_CODES = new Set(["ENOENT", "ENOEXEC"]);
const SPACE_CODES = new Set(["ENOSPC", "EDQUOT"]);
const TRANSIENT_CODES = new Set([
  "ABORT_ERR",
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "ETIMEDOUT",
]);
const MALFORMED_DECODE_CODES = new Set([
  "Z_BUF_ERROR",
  "Z_DATA_ERROR",
  "ZSTD_DECODE_ERROR",
]);

const classifyOperationalFailure = (
  error: unknown,
  fallbackReason: RestoreUnavailableReason,
  options: { decoderContext?: boolean } = {}
): RestoreUnavailableResult | null => {
  const detail = errorDetail(error, "Restore operation failed");
  if (options.decoderContext === true && isToolUnavailableError(error)) {
    return {
      status: "unavailable",
      reason: "zstd-unavailable",
      replaceable: true,
      detail,
    };
  }
  if (hasErrorCode(error, SPACE_CODES)) {
    return {
      status: "unavailable",
      reason: "insufficient-space",
      replaceable: false,
      detail,
    };
  }
  if (hasErrorCode(error, TRANSIENT_CODES)) {
    return {
      status: "unavailable",
      reason: hasErrorMessage(error, "inactive")
        ? "codec-inactive"
        : hasErrorMessage(error, "timed out")
        ? "codec-timeout"
        : fallbackReason,
      replaceable: false,
      detail,
    };
  }
  return null;
};

const classifyDecodeFailure = (
  error: unknown
): Exclude<RestoreResult, { status: "restored" }> => {
  const operational = classifyOperationalFailure(
    error,
    "codec-operational-failure",
    { decoderContext: true }
  );
  if (operational) return operational;
  const detail = errorDetail(error, "Zstd decode failed");
  if (
    hasErrorCode(error, MALFORMED_DECODE_CODES) ||
    hasErrorMessage(error, "zstd exited with ") ||
    hasErrorMessage(error, "declared limit")
  ) {
    return {
      status: "invalid",
      reason: "decode-malformed",
      detail,
    };
  }
  return {
    status: "unavailable",
    reason: hasErrorMessage(error, "inactive")
      ? "codec-inactive"
      : hasErrorMessage(error, "timed out")
      ? "codec-timeout"
      : "codec-operational-failure",
    replaceable: false,
    detail,
  };
};

const discardInvalidRestore = (
  paths: CachePaths,
  stable: string,
  entryId: string
): void => {
  assertManagedDirectory(paths.providerRoot, path.dirname(stable));
  ensureManagedDirectory(paths.providerRoot, paths.trashRoot);
  const tombstone = path.join(
    paths.trashRoot,
    `restore-invalid-${entryId}-${crypto.randomUUID()}`
  );
  fs.renameSync(stable, tombstone);
  try {
    fs.rmSync(tombstone, { recursive: true, force: true });
  } catch {
    // The invalid derived data remains recoverable as managed trash.
  }
};

export const materializeCompressedArtifact = async (input: {
  paths: CachePaths;
  entryDirectory: string;
  manifest: CompressedCacheManifest;
  codec?: ZstdCodec | null;
}): Promise<RestoreResult> => {
  const stable = getRestoreDirectory(
    input.paths,
    input.manifest.platform,
    input.manifest.entryId
  );
  if (pathExists(stable)) {
    let hit: string | null = null;
    try {
      assertManagedDirectory(input.paths.providerRoot, stable);
      hit = validateRestore(stable, input.manifest);
    } catch {
      // A non-directory, symlink, or unsafe restore is disposable derived data.
    }
    if (hit) return { status: "restored", artifactPath: hit, created: false };
    try {
      discardInvalidRestore(input.paths, stable, input.manifest.entryId);
    } catch (error) {
      return {
        status: "unavailable",
        reason: "restore-storage-failure",
        replaceable: false,
        detail: errorDetail(error, "Could not replace invalid restore data"),
      };
    }
  }

  const codec = input.codec === undefined ? discoverZstdCodec() : input.codec;
  if (!codec) {
    return {
      status: "unavailable",
      reason: "zstd-unavailable",
      replaceable: true,
    };
  }

  let capacity: ReturnType<typeof getCompressionCapacity>;
  try {
    capacity = getCompressionCapacity({
      platform: input.manifest.platform,
      logicalSizeBytes: input.manifest.artifact.sizeBytes,
      snapshotApparentBytes: input.manifest.artifact.sizeBytes,
      fileCount: input.manifest.artifact.fileCount,
    });
  } catch (error) {
    return {
      status: "invalid",
      reason: "archive-invalid",
      detail: errorDetail(error, "Restore declarations are invalid"),
    };
  }
  if (
    checkAvailableSpace(stable, capacity.restoreRequiredBytes).status ===
    "insufficient"
  ) {
    return {
      status: "unavailable",
      reason: "insufficient-space",
      replaceable: false,
    };
  }

  let staging: string;
  try {
    ensureManagedDirectory(input.paths.providerRoot, input.paths.restoresRoot);
    ensureManagedDirectory(
      input.paths.providerRoot,
      path.join(input.paths.restoresRoot, input.manifest.platform)
    );
    ensureManagedDirectory(
      input.paths.providerRoot,
      input.paths.restoreStagingRoot
    );
    staging = fs.mkdtempSync(
      path.join(input.paths.restoreStagingRoot, `${input.manifest.entryId}-`)
    );
  } catch (error) {
    const classified = classifyOperationalFailure(
      error,
      "restore-storage-failure"
    );
    return (
      classified ?? {
        status: "unavailable",
        reason: "restore-storage-failure",
        replaceable: false,
        detail: errorDetail(error, "Could not prepare restore staging"),
      }
    );
  }
  const decoded = path.join(staging, "decoded.stream");
  const artifactPath = path.join(
    staging,
    getArtifactName(input.manifest.platform)
  );
  try {
    try {
      await codec.decode(
        path.join(input.entryDirectory, input.manifest.payload.relativePath),
        decoded,
        {
          maxOutputBytes: capacity.archiveBound,
          logicalSizeBytes: Math.max(1, input.manifest.artifact.sizeBytes),
        }
      );
    } catch (error) {
      return classifyDecodeFailure(error);
    }
    if (input.manifest.platform === "ios") {
      try {
        await extractAppTree(decoded, artifactPath, {
          sizeBytes: input.manifest.artifact.sizeBytes,
          fileCount: input.manifest.artifact.fileCount,
          maxArchiveBytes: capacity.archiveBound,
        });
      } catch (error) {
        const operational = classifyOperationalFailure(
          error,
          "restore-storage-failure"
        );
        return (
          operational ?? {
            status: "invalid",
            reason: "archive-invalid",
            detail: errorDetail(error, "App-tree extraction failed"),
          }
        );
      }
      fs.rmSync(decoded, { force: true });
    } else {
      fs.renameSync(decoded, artifactPath);
    }
    let integrity: ReturnType<typeof inspectArtifact>;
    try {
      integrity = inspectArtifact(artifactPath, input.manifest.platform, {
        sizeBytes: input.manifest.artifact.sizeBytes,
        fileCount: input.manifest.artifact.fileCount,
      });
    } catch (error) {
      const operational = classifyOperationalFailure(
        error,
        "restore-storage-failure"
      );
      return (
        operational ?? {
          status: "invalid",
          reason: "integrity-mismatch",
          detail: errorDetail(error, "Restored artifact is invalid"),
        }
      );
    }
    if (
      integrity.algorithm !== input.manifest.artifact.integrity.algorithm ||
      integrity.digest !== input.manifest.artifact.integrity.digest ||
      integrity.sizeBytes !== input.manifest.artifact.sizeBytes ||
      integrity.fileCount !== input.manifest.artifact.fileCount
    ) {
      return {
        status: "invalid",
        reason: "integrity-mismatch",
      };
    }
    fs.writeFileSync(
      path.join(staging, "restore.json"),
      `${JSON.stringify(restoreManifest(input.manifest), null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );
    fs.renameSync(staging, stable);
    return {
      status: "restored",
      artifactPath: path.join(stable, getArtifactName(input.manifest.platform)),
      created: true,
    };
  } catch (error) {
    const operational = classifyOperationalFailure(
      error,
      "restore-storage-failure"
    );
    return (
      operational ?? {
        status: "unavailable",
        reason: "restore-storage-failure",
        replaceable: false,
        detail: errorDetail(error, "Restore publication failed"),
      }
    );
  } finally {
    try {
      if (pathExists(staging)) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    } catch {
      // Abandoned staging is managed cleanup data; never mask the result.
    }
  }
};

export const removeRestoreForEntry = (
  paths: CachePaths,
  platform: "android" | "ios",
  entryId: string
): void => {
  const directory = getRestoreDirectory(paths, platform, entryId);
  if (pathExists(directory)) {
    assertManagedDirectory(paths.providerRoot, path.dirname(directory));
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
