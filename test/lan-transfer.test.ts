import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
} from "../src/cache/paths";
import { acquireEntryLock, releaseEntryLock } from "../src/cache/lock";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
} from "../src/cache/store";
import { readManifest } from "../src/cache/manifest";
import { discoverZstdCodec } from "../src/cache/zstd";
import { createWirePackage } from "../src/lan/export";
import { importWirePackage } from "../src/lan/import";
import {
  WIRE_MAGIC,
  WIRE_PREFIX_BYTES,
  type WireHeader,
} from "../src/lan/wire";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-lan-transfer-"))
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const project = (name: string): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  return fs.realpathSync(directory);
};

const publish = async (
  projectRoot: string,
  fingerprintHash: string,
  contents: string
) => {
  const artifact = path.join(projectRoot, "fixture.apk");
  fs.writeFileSync(artifact, contents);
  await uploadCacheEntry(
    { projectRoot, platform: "android", fingerprintHash },
    artifact
  );
  const entryId = getEntryId("android", fingerprintHash);
  const wirePath = path.join(root, `${crypto.randomUUID()}.wire`);
  await createWirePackage({
    projectRoot,
    platform: "android",
    entryId,
    outputPath: wirePath,
  });
  return { entryId, wirePath };
};

const rewriteBody = (
  sourcePath: string,
  destinationPath: string,
  transform: (body: Buffer) => Buffer
): void => {
  const source = fs.readFileSync(sourcePath);
  const headerLength = source.readUInt32BE(WIRE_MAGIC.length);
  const headerStart = WIRE_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(
    source.subarray(headerStart, headerEnd).toString("utf8")
  ) as WireHeader;
  const manifestEnd = headerEnd + header.manifest.sizeBytes;
  const manifest = source.subarray(headerEnd, manifestEnd);
  const body = transform(Buffer.from(source.subarray(manifestEnd)));
  const rewrittenHeader: WireHeader = {
    ...header,
    body: {
      ...header.body,
      sizeBytes: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    },
  };
  const headerBytes = Buffer.from(JSON.stringify(rewrittenHeader));
  const prefix = Buffer.allocUnsafe(WIRE_PREFIX_BYTES);
  WIRE_MAGIC.copy(prefix);
  prefix.writeUInt32BE(headerBytes.length, WIRE_MAGIC.length);
  fs.writeFileSync(
    destinationPath,
    Buffer.concat([prefix, headerBytes, manifest, body])
  );
};

describe("atomic LAN transfer import", () => {
  it("serializes concurrent imports and publishes exactly one complete entry", async () => {
    const source = project("source");
    const target = project("target");
    const fingerprintHash = "concurrent-transfer";
    const { entryId, wirePath } = await publish(
      source,
      fingerprintHash,
      "concurrent-content".repeat(1_000)
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        importWirePackage({
          projectRoot: target,
          packagePath: wirePath,
          expectedPlatform: "android",
          expectedEntryId: entryId,
        })
      )
    );
    expect(
      results.filter((result) => result.status === "imported")
    ).toHaveLength(1);
    expect(results.every((result) => result.sameGeneration)).toBe(true);

    const resolved = await resolveCacheEntryDetailed({
      projectRoot: target,
      platform: "android",
      fingerprintHash,
    });
    expect(resolved.outcome).toBe("hit");
    const paths = getCachePaths(target);
    expect(fs.readdirSync(paths.transferStagingRoot)).toEqual([]);
    expect(fs.readdirSync(paths.transferLocksRoot)).toEqual([]);
  });

  it("accepts a verified transfer lock already held across download", async () => {
    const source = project("source");
    const target = project("target");
    const transfer = await publish(source, "held-transfer-lock", "artifact");
    const paths = getCachePaths(target);
    fs.mkdirSync(paths.transferLocksRoot, { recursive: true });
    const lock = await acquireEntryLock(
      paths.transferLocksRoot,
      transfer.entryId
    );
    if (!lock) throw new Error("expected transfer lock");
    try {
      expect(
        await importWirePackage({
          projectRoot: target,
          packagePath: transfer.wirePath,
          expectedPlatform: "android",
          expectedEntryId: transfer.entryId,
          transferLock: lock,
        })
      ).toMatchObject({ status: "imported", sameGeneration: true });
      expect(fs.existsSync(lock.directory)).toBe(true);
    } finally {
      releaseEntryLock(lock);
    }
  });

  it("lets a valid local generation win and reports an immutable conflict", async () => {
    const firstSource = project("source-one");
    const secondSource = project("source-two");
    const target = project("target");
    const fingerprintHash = "immutable-generation";
    const first = await publish(firstSource, fingerprintHash, "same-artifact");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await publish(
      secondSource,
      fingerprintHash,
      "same-artifact"
    );
    expect(second.entryId).toBe(first.entryId);

    const initial = await importWirePackage({
      projectRoot: target,
      packagePath: first.wirePath,
      expectedPlatform: "android",
      expectedEntryId: first.entryId,
    });
    const conflict = await importWirePackage({
      projectRoot: target,
      packagePath: second.wirePath,
      expectedPlatform: "android",
      expectedEntryId: second.entryId,
    });
    expect(initial.status).toBe("imported");
    expect(conflict).toMatchObject({
      status: "existing",
      sameGeneration: false,
    });
    const targetManifest = fs.readFileSync(
      path.join(
        getEntryDirectory(getCachePaths(target), "android", first.entryId),
        "manifest.json"
      )
    );
    const firstManifest = fs.readFileSync(
      path.join(
        getEntryDirectory(getCachePaths(firstSource), "android", first.entryId),
        "manifest.json"
      )
    );
    expect(targetManifest).toEqual(firstManifest);
  });

  it("quarantines an invalid local entry before atomic replacement", async () => {
    const source = project("source");
    const target = project("target");
    const fingerprintHash = "replace-corrupt";
    const transfer = await publish(source, fingerprintHash, "healthy");
    await importWirePackage({
      projectRoot: target,
      packagePath: transfer.wirePath,
      expectedPlatform: "android",
      expectedEntryId: transfer.entryId,
    });
    const paths = getCachePaths(target);
    const entry = getEntryDirectory(paths, "android", transfer.entryId);
    fs.appendFileSync(path.join(entry, "artifact.apk"), "corruption");

    const repaired = await importWirePackage({
      projectRoot: target,
      packagePath: transfer.wirePath,
      expectedPlatform: "android",
      expectedEntryId: transfer.entryId,
    });
    expect(repaired.status).toBe("imported");
    expect(fs.readdirSync(paths.quarantineRoot)).toContainEqual(
      expect.stringContaining(`${transfer.entryId}-lan-import-`)
    );
    const resolved = await resolveCacheEntryDetailed({
      projectRoot: target,
      platform: "android",
      fingerprintHash,
    });
    expect(resolved.outcome).toBe("hit");
  });

  it("replaces only the declared unreadable compressed generation with schema 1", async () => {
    if (!discoverZstdCodec()) return;
    const source = project("source");
    const target = project("target");
    const fingerprintHash = "compressed-replacement";
    const contents = "compressible-content".repeat(100_000);
    const artifact = path.join(target, "compressed.apk");
    fs.writeFileSync(artifact, contents);
    await uploadCacheEntry(
      { projectRoot: target, platform: "android", fingerprintHash },
      artifact,
      { compressionMode: "zstd" }
    );
    const entryId = getEntryId("android", fingerprintHash);
    const entry = getEntryDirectory(getCachePaths(target), "android", entryId);
    const compressed = readManifest(entry);
    if (compressed.schemaVersion !== 2) throw new Error("expected compression");
    const transfer = await publish(source, fingerprintHash, contents);

    const preserved = await importWirePackage({
      projectRoot: target,
      packagePath: transfer.wirePath,
      expectedPlatform: "android",
      expectedEntryId: entryId,
      replaceCompressedUnavailable: { payloadDigest: "0".repeat(64) },
    });
    expect(preserved.status).toBe("existing");
    expect(readManifest(entry).schemaVersion).toBe(2);

    const replaced = await importWirePackage({
      projectRoot: target,
      packagePath: transfer.wirePath,
      expectedPlatform: "android",
      expectedEntryId: entryId,
      replaceCompressedUnavailable: {
        payloadDigest: compressed.payload.integrity.digest,
      },
    });
    expect(replaced.status).toBe("imported");
    expect(readManifest(entry).schemaVersion).toBe(1);
  });

  it("removes failed iOS extraction staging without publishing a partial entry", async () => {
    const source = project("source");
    const target = project("target");
    const app = path.join(source, "Fixture.app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "Info.plist"), "<plist/>");
    const fingerprintHash = "broken-app-tree";
    const entryId = getEntryId("ios", fingerprintHash);
    await uploadCacheEntry(
      { projectRoot: source, platform: "ios", fingerprintHash },
      app
    );
    const validPath = path.join(root, "valid-ios.wire");
    await createWirePackage({
      projectRoot: source,
      platform: "ios",
      entryId,
      outputPath: validPath,
    });
    const brokenPath = path.join(root, "broken-ios.wire");
    rewriteBody(validPath, brokenPath, (body) => {
      body.fill(0);
      return body;
    });

    await expect(
      importWirePackage({
        projectRoot: target,
        packagePath: brokenPath,
        expectedPlatform: "ios",
        expectedEntryId: entryId,
      })
    ).rejects.toThrow("App-tree");
    const paths = getCachePaths(target);
    expect(fs.existsSync(getEntryDirectory(paths, "ios", entryId))).toBe(false);
    expect(fs.readdirSync(paths.transferStagingRoot)).toEqual([]);
    expect(fs.readdirSync(paths.transferLocksRoot)).toEqual([]);
  });

  it("does not inspect or publish a package after its absolute import deadline", async () => {
    const source = project("source");
    const target = project("target");
    const transfer = await publish(source, "expired-import", "artifact");

    await expect(
      importWirePackage({
        projectRoot: target,
        packagePath: transfer.wirePath,
        expectedPlatform: "android",
        expectedEntryId: transfer.entryId,
        deadlineMs: Date.now(),
      })
    ).rejects.toThrow("import exceeded its deadline");
    const paths = getCachePaths(target);
    expect(
      fs.existsSync(getEntryDirectory(paths, "android", transfer.entryId))
    ).toBe(false);
  });
});
