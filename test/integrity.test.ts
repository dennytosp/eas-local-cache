import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { inspectArtifact, inspectPayloadFile } from "../src/cache/integrity";
import { MAX_COMPRESSED_BYTES, MAX_LOGICAL_BYTES } from "../src/cache/zstd";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-integrity-"))
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded integrity inspection", () => {
  it("hashes payload bytes in fixed-size chunks", () => {
    const payload = path.join(root, "payload.zst");
    const contents = crypto.randomBytes(2 * 1024 * 1024 + 17);
    fs.writeFileSync(payload, contents);

    const inspected = inspectPayloadFile(payload, contents.length);

    expect(inspected).toEqual({
      sizeBytes: contents.length,
      digest: crypto.createHash("sha256").update(contents).digest("hex"),
    });
  });

  it("rejects a sparse oversized payload before reading it", () => {
    const payload = path.join(root, "oversized.zst");
    fs.closeSync(fs.openSync(payload, "w"));
    fs.truncateSync(payload, MAX_COMPRESSED_BYTES + 1);
    const read = spyOn(fs, "readSync");

    try {
      expect(() => inspectPayloadFile(payload)).toThrow(
        "Compressed cache payload exceeds the cache integrity limit"
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a payload that exceeds its declared size before hashing", () => {
    const payload = path.join(root, "payload.zst");
    fs.writeFileSync(payload, "larger-than-declared");
    const read = spyOn(fs, "readSync");

    try {
      expect(() => inspectPayloadFile(payload, 4)).toThrow(
        "Compressed cache payload size does not match its declaration"
      );
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("detects growth through the open descriptor without hashing the tail", () => {
    const payload = path.join(root, "growing.zst");
    fs.writeFileSync(payload, Buffer.alloc(2 * 1024 * 1024, 7));
    const declaredSize = fs.statSync(payload).size;
    const originalRead = fs.readSync;
    let grew = false;
    const read = spyOn(fs, "readSync").mockImplementation(((
      descriptor,
      buffer,
      offset,
      length,
      position
    ) => {
      const bytesRead = originalRead(
        descriptor,
        buffer,
        offset,
        length,
        position
      );
      if (!grew && bytesRead > 0) {
        grew = true;
        fs.appendFileSync(payload, "growth");
      }
      return bytesRead;
    }) as typeof fs.readSync);

    try {
      expect(() => inspectPayloadFile(payload, declaredSize)).toThrow(
        "Compressed cache payload grew during integrity inspection"
      );
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      read.mockRestore();
    }
  });

  it("bounds Android artifacts by declared and hard logical sizes", () => {
    const artifact = path.join(root, "artifact.apk");
    fs.writeFileSync(artifact, "apk");
    expect(() =>
      inspectArtifact(artifact, "android", { sizeBytes: 2, fileCount: 1 })
    ).toThrow("Android cache artifact size does not match its declaration");

    const oversized = path.join(root, "oversized.apk");
    fs.closeSync(fs.openSync(oversized, "w"));
    fs.truncateSync(oversized, MAX_LOGICAL_BYTES + 1);
    expect(() => inspectArtifact(oversized, "android")).toThrow(
      "Android cache artifact exceeds the cache integrity limit"
    );
  });

  it("stops an app tree before its declared aggregate size is exceeded", () => {
    const app = path.join(root, "Example.app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "Info.plist"), "plist");
    fs.writeFileSync(path.join(app, "binary"), "binary");

    expect(() =>
      inspectArtifact(app, "ios", { sizeBytes: 5, fileCount: 2 })
    ).toThrow("App bundle file binary exceeds the cache integrity limit");
  });
});
