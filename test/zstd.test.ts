import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  discoverZstdCodec,
  resetZstdCodecCacheForTests,
} from "../src/cache/zstd";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-zstd-"))
  );
  resetZstdCodecCacheForTests();
});

afterEach(() => {
  resetZstdCodecCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("zstd codec", () => {
  it("round-trips real bytes through an available codec", async () => {
    const codec = discoverZstdCodec();
    if (!codec) return;

    const source = path.join(root, "source.bin");
    const compressed = path.join(root, "payload.zst");
    const restored = path.join(root, "restored.bin");
    const contents = Buffer.concat([
      Buffer.from("eas-local-cache\0".repeat(1_024)),
      crypto.randomBytes(8_192),
    ]);
    fs.writeFileSync(source, contents);

    await codec.encode(source, compressed, {
      maxOutputBytes: contents.length + 64 * 1024,
      logicalSizeBytes: contents.length,
    });
    await codec.decode(compressed, restored, {
      maxOutputBytes: contents.length,
      logicalSizeBytes: contents.length,
    });

    expect(fs.readFileSync(restored)).toEqual(contents);
  });

  it("stops decoding when output exceeds its declared cap", async () => {
    const codec = discoverZstdCodec();
    if (!codec) return;

    const source = path.join(root, "source.bin");
    const compressed = path.join(root, "payload.zst");
    const restored = path.join(root, "restored.bin");
    const contents = Buffer.from("bounded-output".repeat(4_096));
    fs.writeFileSync(source, contents);
    await codec.encode(source, compressed, {
      maxOutputBytes: contents.length,
      logicalSizeBytes: contents.length,
    });

    await expect(
      codec.decode(compressed, restored, {
        maxOutputBytes: contents.length - 1,
        logicalSizeBytes: contents.length,
      })
    ).rejects.toThrow("Zstd output exceeds its declared limit");
  });

  it("rejects missing input and malformed compressed payloads", async () => {
    const codec = discoverZstdCodec();
    if (!codec) return;

    await expect(
      codec.decode(
        path.join(root, "missing.zst"),
        path.join(root, "missing-output.bin"),
        { maxOutputBytes: 1_024, logicalSizeBytes: 1_024 }
      )
    ).rejects.toThrow();

    const malformed = path.join(root, "malformed.zst");
    fs.writeFileSync(malformed, "not a zstd frame");
    await expect(
      codec.decode(malformed, path.join(root, "malformed-output.bin"), {
        maxOutputBytes: 1_024,
        logicalSizeBytes: 1_024,
      })
    ).rejects.toThrow();
  });

  it("runs the documented CLI arguments when zstd is installed", () => {
    const probe = childProcess.spawnSync("zstd", ["-V"], {
      shell: false,
      encoding: "utf8",
      timeout: 2_000,
    });
    if (probe.status !== 0) return;

    const contents = Buffer.from("real zstd cli smoke\n".repeat(128));
    // Bun's test runner does not reliably forward piped spawn input, so run
    // the real shell-free CLI smoke in the supported Node runtime.
    const script = `
      const childProcess = require("node:child_process");
      const source = Buffer.from(process.argv[1], "base64");
      const encoded = childProcess.spawnSync(
        "zstd",
        ["-3", "--check", "-q", "-c"],
        { shell: false, input: source, maxBuffer: 1024 * 1024 }
      );
      if (encoded.status !== 0) {
        process.stderr.write(encoded.stderr);
        process.exit(encoded.status || 1);
      }
      const decoded = childProcess.spawnSync(
        "zstd",
        ["-d", "--check", "-q", "-c", "-M128MB"],
        { shell: false, input: encoded.stdout, maxBuffer: 1024 * 1024 }
      );
      if (decoded.status !== 0) {
        process.stderr.write(decoded.stderr);
        process.exit(decoded.status || 1);
      }
      require("node:fs").writeFileSync(process.argv[2], decoded.stdout);
    `;
    const restored = path.join(root, "cli-restored.bin");
    const smoke = childProcess.spawnSync(
      "node",
      ["-e", script, contents.toString("base64"), restored],
      { shell: false, maxBuffer: 1024 * 1024 }
    );
    expect(smoke.status).toBe(0);
    expect(fs.readFileSync(restored)).toEqual(contents);
  });
});
