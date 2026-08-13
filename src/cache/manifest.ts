import * as fs from "fs";
import * as path from "path";

import type { ArtifactIntegrity } from "./integrity";
import type { CachePlatform } from "./paths";

export const CACHE_SCHEMA_VERSION = 1;

export type CacheManifest = {
  schemaVersion: 1;
  platform: CachePlatform;
  fingerprintHash: string;
  entryId: string;
  createdAt: string;
  createdBy: {
    name: "eas-local-cache";
    version: string;
  };
  artifact: {
    relativePath: "artifact.apk" | "artifact.app";
    type: "file" | "directory";
    sizeBytes: number;
    fileCount: number;
    integrity: {
      algorithm: ArtifactIntegrity["algorithm"];
      digest: string;
    };
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readManifest = (entryDirectory: string): CacheManifest => {
  const manifestPath = path.join(entryDirectory, "manifest.json");
  const descriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  let contents: string;
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Cache manifest must be a regular file");
    }
    contents = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  const parsed: unknown = JSON.parse(contents);

  if (!isRecord(parsed) || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new Error("Unsupported or malformed cache manifest");
  }

  const createdBy = parsed.createdBy;
  const artifact = parsed.artifact;
  if (!isRecord(createdBy) || !isRecord(artifact)) {
    throw new Error("Malformed cache manifest metadata");
  }

  const integrity = artifact.integrity;
  if (!isRecord(integrity)) {
    throw new Error("Malformed cache integrity metadata");
  }

  const valid =
    (parsed.platform === "android" || parsed.platform === "ios") &&
    typeof parsed.fingerprintHash === "string" &&
    typeof parsed.entryId === "string" &&
    typeof parsed.createdAt === "string" &&
    createdBy.name === "eas-local-cache" &&
    typeof createdBy.version === "string" &&
    (artifact.relativePath === "artifact.apk" ||
      artifact.relativePath === "artifact.app") &&
    (artifact.type === "file" || artifact.type === "directory") &&
    typeof artifact.sizeBytes === "number" &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes >= 0 &&
    typeof artifact.fileCount === "number" &&
    Number.isSafeInteger(artifact.fileCount) &&
    artifact.fileCount >= 1 &&
    (integrity.algorithm === "sha256" ||
      integrity.algorithm === "sha256-tree-v1") &&
    typeof integrity.digest === "string" &&
    /^[a-f0-9]{64}$/.test(integrity.digest);

  if (!valid) {
    throw new Error("Malformed cache manifest fields");
  }

  return parsed as CacheManifest;
};

export const writeManifest = (
  entryDirectory: string,
  manifest: CacheManifest
) => {
  fs.writeFileSync(
    path.join(entryDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
};
