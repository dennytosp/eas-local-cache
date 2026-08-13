import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  MAX_MANIFEST_BYTES,
  readManifest,
  writeManifest,
  type CacheManifest,
  type CacheManifestV1,
  type CompressedCacheManifest,
} from "../src/cache/manifest";
import { MAX_COMPRESSED_BYTES, MAX_LOGICAL_BYTES } from "../src/cache/zstd";

const digest = "a".repeat(64);
const entryId = "b".repeat(64);

const schema1Manifest: CacheManifestV1 = {
  schemaVersion: 1,
  platform: "android",
  fingerprintHash: "fingerprint",
  entryId,
  createdAt: "2026-08-13T00:00:00.000Z",
  createdBy: { name: "eas-local-cache", version: "1.0.4" },
  artifact: {
    relativePath: "artifact.apk",
    type: "file",
    sizeBytes: 12,
    fileCount: 1,
    integrity: { algorithm: "sha256", digest },
  },
};

const schema2Manifest: CompressedCacheManifest = {
  schemaVersion: 2,
  platform: "ios",
  fingerprintHash: "fingerprint",
  entryId,
  createdAt: "2026-08-13T00:00:00.000Z",
  createdBy: { name: "eas-local-cache", version: "1.0.4" },
  artifact: {
    relativePath: "artifact.app",
    type: "directory",
    sizeBytes: 12,
    fileCount: 2,
    integrity: { algorithm: "sha256-tree-v1", digest },
  },
  payload: {
    encoding: "zstd",
    archiveFormat: "elc-app-tree-v1",
    relativePath: "artifact.app.zst",
    sizeBytes: 8,
    integrity: { algorithm: "sha256", digest },
    compressionLevel: 3,
    schema1EquivalentBytes: 20,
  },
};

let root: string;

const writeRawManifest = (contents: string | Buffer): void => {
  fs.writeFileSync(path.join(root, "manifest.json"), contents);
};

const cloneManifest = (manifest: CacheManifest): Record<string, unknown> =>
  JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-manifest-"))
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cache manifests", () => {
  it("round-trips strict schema 1 and schema 2 manifests", () => {
    for (const manifest of [schema1Manifest, schema2Manifest]) {
      writeManifest(root, manifest);
      expect(readManifest(root)).toEqual(manifest);
    }
  });

  it("accepts exactly the read limit and rejects larger files for both schemas", () => {
    for (const manifest of [schema1Manifest, schema2Manifest]) {
      const serialized = JSON.stringify(manifest);
      const exact = `${serialized}${" ".repeat(
        MAX_MANIFEST_BYTES - Buffer.byteLength(serialized)
      )}`;
      expect(Buffer.byteLength(exact)).toBe(MAX_MANIFEST_BYTES);
      writeRawManifest(exact);
      expect(readManifest(root).schemaVersion).toBe(manifest.schemaVersion);

      writeRawManifest(`${exact} `);
      expect(() => readManifest(root)).toThrow(
        "Cache manifest must be a bounded regular file"
      );
    }
  });

  it("rejects empty files and refuses to follow a manifest symlink", () => {
    writeRawManifest("");
    expect(() => readManifest(root)).toThrow(
      "Cache manifest must be a bounded regular file"
    );

    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}.json`
    );
    fs.writeFileSync(outside, JSON.stringify(schema1Manifest));
    fs.rmSync(path.join(root, "manifest.json"));
    fs.symlinkSync(outside, path.join(root, "manifest.json"));
    try {
      expect(() => readManifest(root)).toThrow();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects schema 1 payloads and missing or mismatched schema 2 payloads", () => {
    const schema1WithPayload = cloneManifest(schema1Manifest);
    schema1WithPayload.payload = schema2Manifest.payload;

    const missingPayload = cloneManifest(schema2Manifest);
    delete missingPayload.payload;

    const mismatchedPayload = cloneManifest(schema2Manifest);
    mismatchedPayload.payload = {
      ...schema2Manifest.payload,
      archiveFormat: "raw-v1",
      relativePath: "artifact.apk.zst",
    };

    for (const manifest of [
      schema1WithPayload,
      missingPayload,
      mismatchedPayload,
    ]) {
      writeRawManifest(JSON.stringify(manifest));
      expect(() => readManifest(root)).toThrow();
    }
  });

  it("bounds schema 2 logical and compressed byte declarations", () => {
    const valid = cloneManifest(schema2Manifest);
    valid.artifact = {
      ...schema2Manifest.artifact,
      sizeBytes: MAX_LOGICAL_BYTES,
    };
    valid.payload = {
      ...schema2Manifest.payload,
      sizeBytes: MAX_COMPRESSED_BYTES,
    };
    writeRawManifest(JSON.stringify(valid));
    expect(readManifest(root).schemaVersion).toBe(2);

    const oversizedLogical = cloneManifest(schema2Manifest);
    oversizedLogical.artifact = {
      ...schema2Manifest.artifact,
      sizeBytes: MAX_LOGICAL_BYTES + 1,
    };
    writeRawManifest(JSON.stringify(oversizedLogical));
    expect(() => readManifest(root)).toThrow();

    const oversizedPayload = cloneManifest(schema2Manifest);
    oversizedPayload.payload = {
      ...schema2Manifest.payload,
      sizeBytes: MAX_COMPRESSED_BYTES + 1,
    };
    writeRawManifest(JSON.stringify(oversizedPayload));
    expect(() => readManifest(root)).toThrow();

    const impossibleEquivalent = cloneManifest(schema2Manifest);
    impossibleEquivalent.payload = {
      ...schema2Manifest.payload,
      schema1EquivalentBytes: Number.MAX_SAFE_INTEGER,
    };
    writeRawManifest(JSON.stringify(impossibleEquivalent));
    expect(() => readManifest(root)).toThrow();
  });

  it("refuses to write a manifest beyond the file-size limit", () => {
    const oversized: CacheManifestV1 = {
      ...schema1Manifest,
      fingerprintHash: "x".repeat(MAX_MANIFEST_BYTES),
    };

    expect(() => writeManifest(root, oversized)).toThrow(
      "Cache manifest exceeds its size limit"
    );
    expect(fs.existsSync(path.join(root, "manifest.json"))).toBe(false);
  });
});
