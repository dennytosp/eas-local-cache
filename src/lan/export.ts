import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { encodeAppTree } from "../cache/app-tree";
import {
  assertManagedDirectory,
  assertProviderRoot,
} from "../cache/filesystem";
import { MAX_MANIFEST_BYTES } from "../cache/manifest";
import {
  getCachePaths,
  getEntryDirectory,
  type CachePlatform,
} from "../cache/paths";
import { validateEntry } from "../cache/validation";
import {
  WIRE_MAGIC,
  WIRE_PREFIX_BYTES,
  WIRE_SCHEMA_VERSION,
  copyFileSection,
  getWireBodyKind,
  hashFileSection,
  inspectWirePackage,
  serializeWireHeader,
  writeAll,
  type InspectedWirePackage,
  type WireHeader,
} from "./wire";

const readManifestBytes = (entryDirectory: string): Buffer => {
  const manifestPath = path.join(entryDirectory, "manifest.json");
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_MANIFEST_BYTES) {
      throw new Error("Cache manifest must be a bounded regular file");
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        read,
        bytes.length - read,
        read
      );
      if (count === 0) throw new Error("Cache manifest changed during export");
      read += count;
    }
    const finalStats = fs.fstatSync(descriptor);
    if (
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalStats.size !== stats.size
    ) {
      throw new Error("Cache manifest changed during export");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
};

const inspectBodyFile = (
  bodyPath: string,
  deadlineMs?: number
): { sizeBytes: number; sha256: string } => {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new Error("Wire body inspection exceeded its deadline");
  }
  const pathStats = fs.lstatSync(bodyPath);
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    pathStats.size <= 0
  ) {
    throw new Error("Wire body source must be a non-empty regular file");
  }
  const descriptor = fs.openSync(
    bodyPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.dev !== pathStats.dev ||
      stats.ino !== pathStats.ino ||
      stats.size !== pathStats.size
    ) {
      throw new Error("Wire body source changed before export");
    }
    return {
      sizeBytes: stats.size,
      sha256: hashFileSection(
        descriptor,
        0,
        stats.size,
        "Wire body source",
        deadlineMs
      ),
    };
  } finally {
    fs.closeSync(descriptor);
  }
};

export const createWirePackage = async (input: {
  projectRoot: string;
  platform: CachePlatform;
  entryId: string;
  outputPath: string;
  deadlineMs?: number;
}): Promise<InspectedWirePackage> => {
  const assertDeadline = (): void => {
    if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
      throw new Error("Wire package export exceeded its deadline");
    }
  };
  assertDeadline();
  const managedProjectRoot = fs.realpathSync(input.projectRoot);
  const paths = getCachePaths(managedProjectRoot);
  assertProviderRoot(managedProjectRoot, paths.providerRoot);
  const entryDirectory = getEntryDirectory(
    paths,
    input.platform,
    input.entryId
  );
  assertManagedDirectory(paths.providerRoot, entryDirectory);

  const initialManifestBytes = readManifestBytes(entryDirectory);
  let initialManifest: unknown;
  try {
    initialManifest = JSON.parse(initialManifestBytes.toString("utf8"));
  } catch {
    throw new Error("Cannot export an invalid cache manifest");
  }
  if (
    typeof initialManifest !== "object" ||
    initialManifest === null ||
    !("fingerprintHash" in initialManifest) ||
    typeof initialManifest.fingerprintHash !== "string"
  ) {
    throw new Error("Cannot export an invalid cache manifest identity");
  }
  const validation = validateEntry(
    entryDirectory,
    paths.providerRoot,
    input.platform,
    initialManifest.fingerprintHash,
    input.entryId,
    { deadlineMs: input.deadlineMs }
  );
  if (!validation.valid) {
    throw new Error(`Cannot export invalid cache entry: ${validation.reason}`);
  }

  const outputParent = path.dirname(path.resolve(input.outputPath));
  const parentStats = fs.lstatSync(outputParent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error("Wire output parent must be a real directory");
  }
  const temporaryBodyPath = path.join(
    outputParent,
    `${input.entryId}-.wire-body-${process.pid}-${crypto.randomUUID()}`
  );
  let bodyPath: string;
  let bodyIsTemporary = false;
  try {
    if (validation.manifest.schemaVersion === 2) {
      if (!validation.payloadPath) {
        throw new Error("Compressed cache entry has no validated payload");
      }
      bodyPath = validation.payloadPath;
    } else if (input.platform === "android") {
      if (!validation.artifactPath) {
        throw new Error("Android cache entry has no validated artifact");
      }
      bodyPath = validation.artifactPath;
    } else {
      if (!validation.artifactPath) {
        throw new Error("iOS cache entry has no validated artifact");
      }
      await encodeAppTree(validation.artifactPath, temporaryBodyPath, {
        deadlineMs: input.deadlineMs,
      });
      bodyPath = temporaryBodyPath;
      bodyIsTemporary = true;
    }

    assertDeadline();
    const body = inspectBodyFile(bodyPath, input.deadlineMs);
    const manifestBytes = readManifestBytes(entryDirectory);
    if (!manifestBytes.equals(initialManifestBytes)) {
      throw new Error("Cache manifest changed during wire export");
    }
    const finalValidation = validateEntry(
      entryDirectory,
      paths.providerRoot,
      input.platform,
      validation.manifest.fingerprintHash,
      input.entryId,
      { deadlineMs: input.deadlineMs }
    );
    if (!finalValidation.valid) {
      throw new Error(
        `Cache entry changed during wire export: ${finalValidation.reason}`
      );
    }
    const header: WireHeader = {
      schemaVersion: WIRE_SCHEMA_VERSION,
      platform: input.platform,
      entryId: input.entryId,
      manifest: {
        sizeBytes: manifestBytes.length,
        sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),
      },
      body: {
        kind: getWireBodyKind(validation.manifest),
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
      },
    };
    const headerBytes = serializeWireHeader(header);
    const prefix = Buffer.allocUnsafe(WIRE_PREFIX_BYTES);
    WIRE_MAGIC.copy(prefix, 0);
    prefix.writeUInt32BE(headerBytes.length, WIRE_MAGIC.length);

    const output = fs.openSync(
      input.outputPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    let complete = false;
    try {
      writeAll(output, prefix);
      writeAll(output, headerBytes);
      writeAll(output, manifestBytes);
      const source = fs.openSync(
        bodyPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      );
      try {
        assertDeadline();
        copyFileSection({
          sourceDescriptor: source,
          destinationDescriptor: output,
          offset: 0,
          length: body.sizeBytes,
          label: "Wire body source",
          ...(input.deadlineMs ? { deadlineMs: input.deadlineMs } : {}),
        });
      } finally {
        fs.closeSync(source);
      }
      fs.fsyncSync(output);
      complete = true;
    } finally {
      fs.closeSync(output);
      if (!complete) fs.rmSync(input.outputPath, { force: true });
    }

    try {
      return inspectWirePackage({
        packagePath: input.outputPath,
        expectedPlatform: input.platform,
        expectedEntryId: input.entryId,
        ...(input.deadlineMs ? { deadlineMs: input.deadlineMs } : {}),
      });
    } catch (error) {
      fs.rmSync(input.outputPath, { force: true });
      throw error;
    }
  } finally {
    if (bodyIsTemporary) fs.rmSync(temporaryBodyPath, { force: true });
  }
};
