import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  appTreeArchiveBound,
  encodeAppTree,
  extractAppTree,
} from "../src/cache/app-tree";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-app-tree-"))
  );
  roots.push(root);
  return root;
};

const archive = (
  records: Array<{
    type: number;
    path: string | Buffer;
    mode: number;
    data?: string | Buffer;
    length?: bigint;
  }>,
  trailing = Buffer.alloc(0)
): Buffer => {
  const parts: Uint8Array[] = [Buffer.from("ELCAPP1\n")];
  for (const record of records) {
    const pathBytes = Buffer.isBuffer(record.path)
      ? record.path
      : Buffer.from(record.path);
    const data = Buffer.isBuffer(record.data)
      ? record.data
      : Buffer.from(record.data ?? "");
    const header = Buffer.alloc(1 + 4 + pathBytes.length + 4 + 8);
    header.writeUInt8(record.type, 0);
    header.writeUInt32BE(pathBytes.length, 1);
    pathBytes.copy(header, 5);
    header.writeUInt32BE(record.mode, 5 + pathBytes.length);
    header.writeBigUInt64BE(
      record.length ?? BigInt(data.length),
      9 + pathBytes.length
    );
    parts.push(header, data);
  }
  parts.push(Buffer.from([0]), trailing);
  return Buffer.concat(parts);
};

const writeArchive = (root: string, contents: Buffer): string => {
  const archivePath = path.join(root, `tree-${crypto.randomUUID()}`);
  fs.writeFileSync(archivePath, contents);
  return archivePath;
};

describe("ELCAPP1 app-tree archives", () => {
  it("round-trips deterministically with modes, Unicode, and internal symlinks", async () => {
    const root = makeRoot();
    const source = path.join(root, "Source.app");
    fs.mkdirSync(path.join(source, "Frameworks", "Nested"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(source, "Info.plist"), "plist");
    fs.writeFileSync(path.join(source, "Frameworks", "run"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "Frameworks", "run"), 0o751);
    fs.writeFileSync(path.join(source, "é.txt"), "café");
    const sourceLink = path.join(source, "Frameworks", "Info");
    fs.symlinkSync("../Info.plist", sourceLink);
    const expectedLinkMode =
      typeof fs.lchmodSync === "function" ? 0o755 : 0o777;
    if (typeof fs.lchmodSync === "function") {
      fs.lchmodSync(sourceLink, expectedLinkMode);
    }
    fs.chmodSync(path.join(source, "Frameworks"), 0o750);

    const first = path.join(root, "first.elc");
    const second = path.join(root, "second.elc");
    const firstStats = await encodeAppTree(source, first);
    const secondStats = await encodeAppTree(source, second);
    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
    expect(firstStats).toEqual(secondStats);
    expect(firstStats.fileCount).toBe(3);

    const destination = path.join(root, "Restored.app");
    const extracted = await extractAppTree(first, destination, {
      sizeBytes: firstStats.sizeBytes,
      fileCount: firstStats.fileCount,
      maxArchiveBytes: appTreeArchiveBound(
        firstStats.sizeBytes,
        firstStats.fileCount
      ),
    });
    expect(extracted).toEqual(firstStats);
    expect(
      fs.readFileSync(path.join(destination, "Frameworks", "run"), "utf8")
    ).toBe("#!/bin/sh\n");
    expect(
      fs.statSync(path.join(destination, "Frameworks", "run")).mode & 0o7777
    ).toBe(0o751);
    expect(
      fs.statSync(path.join(destination, "Frameworks")).mode & 0o7777
    ).toBe(0o750);
    expect(fs.readlinkSync(path.join(destination, "Frameworks", "Info"))).toBe(
      "../Info.plist"
    );
    expect(
      fs.lstatSync(path.join(destination, "Frameworks", "Info")).mode & 0o7777
    ).toBe(expectedLinkMode);
    expect(fs.readFileSync(path.join(destination, "é.txt"), "utf8")).toBe(
      "café"
    );
  });

  it("rejects traversal, noncanonical paths, invalid UTF-8, and missing parents", async () => {
    const cases: Array<{ path: string | Buffer; data?: string }> = [
      { path: "../outside", data: "x" },
      { path: "/absolute", data: "x" },
      { path: "a//b", data: "x" },
      { path: "a/./b", data: "x" },
      { path: "trailing/", data: "x" },
      { path: "de\u0301composed", data: "x" },
      { path: Buffer.from([0xff]), data: "x" },
      { path: "missing/child", data: "x" },
    ];
    for (const entry of cases) {
      const root = makeRoot();
      const input = writeArchive(
        root,
        archive([{ type: 2, path: entry.path, mode: 0o600, data: entry.data }])
      );
      await expect(
        extractAppTree(input, path.join(root, "out"), {
          sizeBytes: 1,
          fileCount: 1,
        })
      ).rejects.toThrow();
    }
  });

  it("rejects escaping and noncanonical symlink targets", async () => {
    const targets = ["../../outside", "/outside", "a/../b", "a//b", "a\\b"];
    for (const target of targets) {
      const root = makeRoot();
      const input = writeArchive(
        root,
        archive([
          { type: 1, path: "Links", mode: 0o755 },
          { type: 3, path: "Links/link", mode: 0o777, data: target },
          { type: 2, path: "payload", mode: 0o600, data: "x" },
        ])
      );
      await expect(
        extractAppTree(input, path.join(root, "out"), {
          sizeBytes: 1,
          fileCount: 1,
        })
      ).rejects.toThrow();
    }
  });

  it("rejects duplicate, out-of-order, and filesystem-alias records", async () => {
    const recordSets = [
      [
        { type: 2, path: "same", mode: 0o600, data: "x" },
        { type: 2, path: "same", mode: 0o600, data: "y" },
      ],
      [
        { type: 2, path: "z", mode: 0o600, data: "x" },
        { type: 2, path: "a", mode: 0o600, data: "y" },
      ],
      [
        { type: 2, path: "Name", mode: 0o600, data: "x" },
        { type: 2, path: "name", mode: 0o600, data: "y" },
      ],
    ];
    for (const records of recordSets) {
      const root = makeRoot();
      const input = writeArchive(root, archive(records));
      await expect(
        extractAppTree(input, path.join(root, "out"), {
          sizeBytes: 2,
          fileCount: 2,
        })
      ).rejects.toThrow();
    }
  });

  it("rejects unsafe u64 lengths before conversion and exact declaration mismatches", async () => {
    const root = makeRoot();
    const unsafe = writeArchive(
      root,
      archive([
        {
          type: 2,
          path: "file",
          mode: 0o600,
          length: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        },
      ])
    );
    await expect(
      extractAppTree(unsafe, path.join(root, "unsafe-out"), {
        sizeBytes: 1,
        fileCount: 1,
      })
    ).rejects.toThrow("safe integer");

    const ordinary = writeArchive(
      root,
      archive([{ type: 2, path: "file", mode: 0o600, data: "x" }])
    );
    await expect(
      extractAppTree(ordinary, path.join(root, "count-out"), {
        sizeBytes: 1,
        fileCount: 2,
      })
    ).rejects.toThrow("exact declarations");
    await expect(
      extractAppTree(ordinary, path.join(root, "size-out"), {
        sizeBytes: 2,
        fileCount: 1,
      })
    ).rejects.toThrow("exact declarations");
  });

  it("rejects trailing bytes, unsupported types, directory data, and invalid modes", async () => {
    const inputs: Array<{ contents: Buffer; message: string; name?: string }> =
      [
        {
          contents: archive(
            [{ type: 2, path: "file", mode: 0o600, data: "x" }],
            Buffer.from("x")
          ),
          message: "bytes after",
        },
        {
          contents: archive([{ type: 9, path: "file", mode: 0o600 }]),
          message: "unsupported record type",
        },
        {
          contents: archive([{ type: 1, path: "dir", mode: 0o755, data: "x" }]),
          message: "directory record contains data",
        },
        {
          contents: archive([
            { type: 2, path: "file", mode: 0o10000, data: "x" },
          ]),
          message: "invalid mode",
          name: "file mode above 07777",
        },
      ];
    for (const inputCase of inputs) {
      const root = makeRoot();
      const input = writeArchive(root, inputCase.contents);
      let rejection: unknown;
      try {
        await extractAppTree(input, path.join(root, "out"), {
          sizeBytes: 1,
          fileCount: 1,
        });
      } catch (error) {
        rejection = error;
      }
      if (!(rejection instanceof Error)) {
        throw new Error(
          `Hostile app-tree input resolved: ${
            inputCase.name ?? inputCase.message
          }`
        );
      }
      expect(rejection.message).toContain(inputCase.message);
    }
  });

  it("requires exclusive archive and extraction paths without following symlinks", async () => {
    const root = makeRoot();
    const source = path.join(root, "Source.app");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "Info.plist"), "x");
    const occupiedArchive = path.join(root, "occupied.elc");
    fs.writeFileSync(occupiedArchive, "keep");
    await expect(encodeAppTree(source, occupiedArchive)).rejects.toThrow();
    expect(fs.readFileSync(occupiedArchive, "utf8")).toBe("keep");

    const validArchive = path.join(root, "valid.elc");
    const stats = await encodeAppTree(source, validArchive);
    const destination = path.join(root, "occupied.app");
    fs.mkdirSync(destination);
    fs.symlinkSync("../outside", path.join(destination, "Info.plist"));
    await expect(
      extractAppTree(validArchive, destination, {
        sizeBytes: stats.sizeBytes,
        fileCount: stats.fileCount,
      })
    ).rejects.toThrow("destination");
  });

  it("checks one absolute deadline throughout extraction loops", async () => {
    const root = makeRoot();
    const input = writeArchive(
      root,
      archive(
        Array.from({ length: 64 }, (_, index) => ({
          type: 2,
          path: `file-${String(index).padStart(3, "0")}`,
          mode: 0o600,
          data: "x",
        }))
      )
    );
    const baseTime = 1_000_000;
    let checks = 0;
    const now = spyOn(Date, "now").mockImplementation(
      () => baseTime + checks++
    );
    try {
      await expect(
        extractAppTree(
          input,
          path.join(root, "deadline-out"),
          { sizeBytes: 64, fileCount: 64 },
          { deadlineMs: baseTime + 20 }
        )
      ).rejects.toThrow("extraction exceeded its deadline");
    } finally {
      now.mockRestore();
    }
  });
});
