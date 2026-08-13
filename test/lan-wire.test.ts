import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readManifest } from "../src/cache/manifest";
import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
} from "../src/cache/paths";
import {
  resolveCacheEntryDetailed,
  uploadCacheEntry,
} from "../src/cache/store";
import { discoverZstdCodec } from "../src/cache/zstd";
import { createWirePackage } from "../src/lan/export";
import { importWirePackage } from "../src/lan/import";
import {
  WIRE_MAGIC,
  WIRE_PREFIX_BYTES,
  inspectWirePackage,
  type WireHeader,
} from "../src/lan/wire";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-lan-wire-"))
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const project = (name: string): string => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  return fs.realpathSync(directory);
};

const packagePath = (name: string): string => path.join(root, `${name}.wire`);

const parsePackage = (wirePath: string) => {
  const contents = fs.readFileSync(wirePath);
  const headerLength = contents.readUInt32BE(WIRE_MAGIC.length);
  const headerStart = WIRE_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(
    contents.subarray(headerStart, headerEnd).toString("utf8")
  ) as WireHeader;
  const manifestEnd = headerEnd + header.manifest.sizeBytes;
  return {
    header,
    manifest: contents.subarray(headerEnd, manifestEnd),
    body: contents.subarray(manifestEnd),
  };
};

const writePackage = (
  wirePath: string,
  input: { header: Record<string, unknown>; manifest: Buffer; body: Buffer }
): void => {
  const headerBytes = Buffer.from(JSON.stringify(input.header), "utf8");
  const prefix = Buffer.allocUnsafe(WIRE_PREFIX_BYTES);
  WIRE_MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, WIRE_MAGIC.length);
  fs.writeFileSync(
    wirePath,
    Buffer.concat([prefix, headerBytes, input.manifest, input.body])
  );
};

const publishAndroid = async (
  projectRoot: string,
  fingerprintHash: string,
  contents = "android-artifact"
) => {
  const apk = path.join(projectRoot, "fixture.apk");
  fs.writeFileSync(apk, contents);
  await uploadCacheEntry(
    { projectRoot, platform: "android", fingerprintHash },
    apk
  );
  return { apk, entryId: getEntryId("android", fingerprintHash) };
};

describe("ELCWIRE1", () => {
  it("exports exact Android manifest bytes and imports a normal cache entry", async () => {
    const source = project("source");
    const target = project("target");
    const fingerprintHash = "lan-wire-android";
    const { apk, entryId } = await publishAndroid(
      source,
      fingerprintHash,
      "apk-content".repeat(1_000)
    );
    const output = packagePath("android");
    const inspected = await createWirePackage({
      projectRoot: source,
      platform: "android",
      entryId,
      outputPath: output,
    });

    const sourceManifest = fs.readFileSync(
      path.join(
        getEntryDirectory(getCachePaths(source), "android", entryId),
        "manifest.json"
      )
    );
    expect(inspected.manifestBytes).toEqual(sourceManifest);
    expect(inspected.header.body).toMatchObject({
      kind: "raw-apk-v1",
      sizeBytes: fs.statSync(apk).size,
    });
    expect(inspected.totalBytes).toBe(fs.statSync(output).size);

    const imported = await importWirePackage({
      projectRoot: target,
      packagePath: output,
      expectedPlatform: "android",
      expectedEntryId: entryId,
    });
    expect(imported).toMatchObject({
      status: "imported",
      sameGeneration: true,
    });
    const resolved = await resolveCacheEntryDetailed({
      projectRoot: target,
      platform: "android",
      fingerprintHash,
    });
    expect(resolved.outcome).toBe("hit");
    if (resolved.outcome !== "hit") throw new Error("expected imported hit");
    expect(fs.readFileSync(resolved.path)).toEqual(fs.readFileSync(apk));
  });

  it("transfers iOS apps through the deterministic app-tree body", async () => {
    const source = project("source");
    const target = project("target");
    const app = path.join(source, "Fixture.app");
    fs.mkdirSync(path.join(app, "Frameworks", "Fixture.framework"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(app, "Info.plist"), "<plist/>");
    fs.writeFileSync(path.join(app, "binary"), "native", { mode: 0o755 });
    fs.symlinkSync(
      "../../binary",
      path.join(app, "Frameworks", "Fixture.framework", "Current")
    );
    const fingerprintHash = "lan-wire-ios";
    const entryId = getEntryId("ios", fingerprintHash);
    await uploadCacheEntry(
      { projectRoot: source, platform: "ios", fingerprintHash },
      app
    );
    const output = packagePath("ios");
    const inspected = await createWirePackage({
      projectRoot: source,
      platform: "ios",
      entryId,
      outputPath: output,
    });
    expect(inspected.header.body.kind).toBe("elc-app-tree-v1");

    await importWirePackage({
      projectRoot: target,
      packagePath: output,
      expectedPlatform: "ios",
      expectedEntryId: entryId,
    });
    const resolved = await resolveCacheEntryDetailed({
      projectRoot: target,
      platform: "ios",
      fingerprintHash,
    });
    expect(resolved.outcome).toBe("hit");
    if (resolved.outcome !== "hit") throw new Error("expected imported hit");
    expect(fs.statSync(path.join(resolved.path, "binary")).mode & 0o777).toBe(
      0o755
    );
    expect(
      fs.readlinkSync(
        path.join(resolved.path, "Frameworks", "Fixture.framework", "Current")
      )
    ).toBe("../../binary");
  });

  it("copies schema 2 zstd bytes without decoding during import", async () => {
    if (!discoverZstdCodec()) return;
    const source = project("source");
    const target = project("target");
    const fingerprintHash = "lan-wire-zstd";
    const apk = path.join(source, "fixture.apk");
    fs.writeFileSync(apk, "compressible".repeat(100_000));
    const entryId = getEntryId("android", fingerprintHash);
    await uploadCacheEntry(
      { projectRoot: source, platform: "android", fingerprintHash },
      apk,
      { compressionMode: "zstd" }
    );
    const sourceEntry = getEntryDirectory(
      getCachePaths(source),
      "android",
      entryId
    );
    const manifest = readManifest(sourceEntry);
    if (manifest.schemaVersion !== 2) throw new Error("expected zstd entry");
    const output = packagePath("zstd");
    const inspected = await createWirePackage({
      projectRoot: source,
      platform: "android",
      entryId,
      outputPath: output,
    });
    expect(inspected.header.body.kind).toBe("zstd-v1");

    await importWirePackage({
      projectRoot: target,
      packagePath: output,
      expectedPlatform: "android",
      expectedEntryId: entryId,
    });
    const targetEntry = getEntryDirectory(
      getCachePaths(target),
      "android",
      entryId
    );
    expect(
      fs.readFileSync(path.join(targetEntry, manifest.payload.relativePath))
    ).toEqual(
      fs.readFileSync(path.join(sourceEntry, manifest.payload.relativePath))
    );
    expect(readManifest(targetEntry)).toEqual(manifest);
  });

  it("rejects bad magic, noncanonical or extra header fields, and trailing bytes", async () => {
    const source = project("source");
    const { entryId } = await publishAndroid(source, "malformed-header");
    const validPath = packagePath("valid");
    await createWirePackage({
      projectRoot: source,
      platform: "android",
      entryId,
      outputPath: validPath,
    });
    const parsed = parsePackage(validPath);

    const badMagic = packagePath("bad-magic");
    const badMagicBytes = fs.readFileSync(validPath);
    badMagicBytes[0] = 0;
    fs.writeFileSync(badMagic, badMagicBytes);
    expect(() => inspectWirePackage({ packagePath: badMagic })).toThrow(
      "invalid magic"
    );

    const extra = packagePath("extra-header");
    writePackage(extra, {
      header: { ...parsed.header, secret: "must-not-appear" },
      manifest: parsed.manifest,
      body: parsed.body,
    });
    expect(() => inspectWirePackage({ packagePath: extra })).toThrow(
      "malformed fields"
    );

    const noncanonical = packagePath("noncanonical-header");
    const headerBytes = Buffer.from(`${JSON.stringify(parsed.header)} `);
    const prefix = Buffer.allocUnsafe(WIRE_PREFIX_BYTES);
    WIRE_MAGIC.copy(prefix);
    prefix.writeUInt32BE(headerBytes.length, WIRE_MAGIC.length);
    fs.writeFileSync(
      noncanonical,
      Buffer.concat([prefix, headerBytes, parsed.manifest, parsed.body])
    );
    expect(() => inspectWirePackage({ packagePath: noncanonical })).toThrow(
      "canonical JSON"
    );

    const trailing = packagePath("trailing");
    fs.writeFileSync(
      trailing,
      Buffer.concat([fs.readFileSync(validPath), Buffer.from("extra")])
    );
    expect(() => inspectWirePackage({ packagePath: trailing })).toThrow(
      "trailing bytes"
    );
  });

  it("rejects manifest metadata, identity, body-kind, digest, and truncation attacks", async () => {
    const source = project("source");
    const { entryId } = await publishAndroid(source, "malformed-content");
    const validPath = packagePath("valid");
    await createWirePackage({
      projectRoot: source,
      platform: "android",
      entryId,
      outputPath: validPath,
    });
    const parsed = parsePackage(validPath);

    const extraManifest = packagePath("manifest-field");
    const manifest = JSON.parse(parsed.manifest.toString("utf8")) as Record<
      string,
      unknown
    >;
    manifest.insight = { source: "private" };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    writePackage(extraManifest, {
      header: {
        ...parsed.header,
        manifest: {
          sizeBytes: manifestBytes.length,
          sha256: crypto
            .createHash("sha256")
            .update(manifestBytes)
            .digest("hex"),
        },
      },
      manifest: manifestBytes,
      body: parsed.body,
    });
    expect(() => inspectWirePackage({ packagePath: extraManifest })).toThrow(
      "unsupported fields"
    );

    const wrongIdentity = packagePath("identity");
    writePackage(wrongIdentity, {
      header: { ...parsed.header, entryId: "0".repeat(64) },
      manifest: parsed.manifest,
      body: parsed.body,
    });
    expect(() => inspectWirePackage({ packagePath: wrongIdentity })).toThrow(
      "identity"
    );

    const wrongKind = packagePath("kind");
    writePackage(wrongKind, {
      header: {
        ...parsed.header,
        body: { ...parsed.header.body, kind: "zstd-v1" },
      },
      manifest: parsed.manifest,
      body: parsed.body,
    });
    expect(() => inspectWirePackage({ packagePath: wrongKind })).toThrow(
      "body kind"
    );

    const badDigest = packagePath("digest");
    const damagedBody = Buffer.from(parsed.body);
    damagedBody[0] = damagedBody[0]! ^ 1;
    writePackage(badDigest, {
      header: parsed.header,
      manifest: parsed.manifest,
      body: damagedBody,
    });
    expect(() => inspectWirePackage({ packagePath: badDigest })).toThrow(
      "body digest"
    );

    const truncated = packagePath("truncated");
    fs.writeFileSync(truncated, fs.readFileSync(validPath).subarray(0, -1));
    expect(() => inspectWirePackage({ packagePath: truncated })).toThrow(
      "truncated"
    );
  });
});
