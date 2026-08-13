import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readManifest } from "../src/cache/manifest";
import {
  getCachePaths,
  getEntryDirectory,
  getEntryId,
  getRestoreDirectory,
} from "../src/cache/paths";
import {
  materializeCompressedArtifact,
  type RestoreUnavailableReason,
} from "../src/cache/restore";
import { uploadCacheEntry } from "../src/cache/store";
import { discoverZstdCodec, type ZstdCodec } from "../src/cache/zstd";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-restore-test-"))
  );
});

afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

const seedCompressedAndroidEntry = async () => {
  const artifact = path.join(projectRoot, "fixture.apk");
  fs.writeFileSync(artifact, "compressible-restore".repeat(100_000));
  const fingerprintHash = "restore-fixture";
  await uploadCacheEntry(
    { projectRoot, platform: "android", fingerprintHash },
    artifact,
    { compressionMode: "zstd" }
  );
  const paths = getCachePaths(projectRoot);
  const entryId = getEntryId("android", fingerprintHash);
  const entryDirectory = getEntryDirectory(paths, "android", entryId);
  const manifest = readManifest(entryDirectory);
  if (manifest.schemaVersion !== 2) throw new Error("expected compression");
  return { paths, entryId, entryDirectory, manifest };
};

const codedError = (
  message: string,
  code: string,
  syscall?: string
): Error & { code: string; syscall?: string } =>
  Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });

const failingCodec = (error: Error): ZstdCodec => ({
  kind: "node",
  encode: async () => {
    throw new Error("encode is not used by restore tests");
  },
  decode: async () => {
    throw error;
  },
});

const restoreWith = (
  seeded: Awaited<ReturnType<typeof seedCompressedAndroidEntry>>,
  codec: ZstdCodec | null
) =>
  materializeCompressedArtifact({
    paths: seeded.paths,
    entryDirectory: seeded.entryDirectory,
    manifest: seeded.manifest,
    codec,
  });

describe("compressed artifact restoration", () => {
  it("reuses a committed restore before looking for a decoder", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedAndroidEntry();
    const created = await restoreWith(seeded, discoverZstdCodec());
    expect(created).toMatchObject({ status: "restored", created: true });

    const reused = await restoreWith(seeded, null);
    expect(reused).toMatchObject({ status: "restored", created: false });
  });

  it("tombstones non-directory and symlink restore nodes without following them", async () => {
    const codec = discoverZstdCodec();
    if (!codec) return;
    const seeded = await seedCompressedAndroidEntry();
    const stable = getRestoreDirectory(seeded.paths, "android", seeded.entryId);
    fs.mkdirSync(path.dirname(stable), { recursive: true });

    fs.writeFileSync(stable, "invalid derived restore");
    expect(await restoreWith(seeded, codec)).toMatchObject({
      status: "restored",
      created: true,
    });
    expect(fs.lstatSync(stable).isDirectory()).toBe(true);

    fs.rmSync(stable, { recursive: true, force: true });
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "eas-restore-outside-")
    );
    try {
      const sentinel = path.join(outside, "sentinel");
      fs.writeFileSync(sentinel, "keep");
      fs.symlinkSync(outside, stable, "dir");

      expect(await restoreWith(seeded, codec)).toMatchObject({
        status: "restored",
        created: true,
      });
      expect(fs.lstatSync(stable).isDirectory()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps the source entry on unavailable and transient decoder failures", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedAndroidEntry();
    const cases: Array<{
      error: Error;
      reason: RestoreUnavailableReason;
      replaceable: boolean;
    }> = [
      {
        error: codedError(
          "decoder executable disappeared",
          "ENOENT",
          "spawn zstd"
        ),
        reason: "zstd-unavailable",
        replaceable: true,
      },
      {
        error: codedError("Zstd operation timed out", "ABORT_ERR"),
        reason: "codec-timeout",
        replaceable: false,
      },
      {
        error: codedError("Zstd operation became inactive", "ABORT_ERR"),
        reason: "codec-inactive",
        replaceable: false,
      },
      {
        error: codedError("disk full", "ENOSPC"),
        reason: "insufficient-space",
        replaceable: false,
      },
      {
        error: codedError("try again", "EAGAIN"),
        reason: "codec-operational-failure",
        replaceable: false,
      },
      {
        error: codedError("payload read raced", "ENOENT", "open"),
        reason: "codec-operational-failure",
        replaceable: false,
      },
      {
        error: new Error("temporary decoder service failure"),
        reason: "codec-operational-failure",
        replaceable: false,
      },
    ];

    for (const testCase of cases) {
      expect(await restoreWith(seeded, failingCodec(testCase.error))).toEqual({
        status: "unavailable",
        reason: testCase.reason,
        replaceable: testCase.replaceable,
        detail: testCase.error.message,
      });
      expect(fs.existsSync(seeded.entryDirectory)).toBe(true);
      expect(fs.readdirSync(seeded.paths.restoreStagingRoot)).toEqual([]);
    }
  });

  it("classifies deterministic malformed output and integrity mismatch as invalid", async () => {
    if (!discoverZstdCodec()) return;
    const seeded = await seedCompressedAndroidEntry();
    const malformed = codedError("invalid zstd frame", "Z_DATA_ERROR");
    expect(await restoreWith(seeded, failingCodec(malformed))).toEqual({
      status: "invalid",
      reason: "decode-malformed",
      detail: malformed.message,
    });

    const wrongOutputCodec: ZstdCodec = {
      kind: "node",
      encode: async () => {
        throw new Error("encode is not used by restore tests");
      },
      decode: async (_input, output) => {
        fs.writeFileSync(output, "wrong artifact");
      },
    };
    expect(await restoreWith(seeded, wrongOutputCodec)).toMatchObject({
      status: "invalid",
      reason: "integrity-mismatch",
    });
    expect(fs.existsSync(seeded.entryDirectory)).toBe(true);
  });
});
