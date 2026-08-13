import * as fs from "fs";
import * as path from "path";

const MAGIC = Buffer.from("ELCAPP1\n", "ascii");
const END = 0;
const DIRECTORY = 1;
const FILE = 2;
const SYMLINK = 3;

export const MAX_APP_TREE_RECORDS = 1_000_000;
export const MAX_APP_TREE_PATH_BYTES = 4 * 1024;
export const MAX_APP_TREE_HEADER_BYTES = 64 * 1024;
export const MAX_APP_TREE_LOGICAL_BYTES = 100 * 1024 ** 3;
const MAX_APP_TREE_METADATA_BYTES = 1024 ** 3;
const BASE_METADATA_BYTES = 8 * 1024 ** 2;
const METADATA_BYTES_PER_FILE = 8 * 1024;
const IO_BUFFER_BYTES = 64 * 1024;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type AppTreeArchiveStats = {
  archiveBytes: number;
  sizeBytes: number;
  fileCount: number;
  recordCount: number;
};

export type AppTreeDeclarations = {
  sizeBytes: number;
  fileCount: number;
  maxArchiveBytes?: number;
};

type SourceRecord = {
  absolutePath: string;
  path: string;
  pathBytes: Buffer;
  stats: fs.Stats;
};

const checkedInteger = (
  value: number,
  name: string,
  maximum: number,
  allowZero = true
): number => {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    throw new Error(`${name} is outside the app-tree limit`);
  }
  return value;
};

export const appTreeArchiveBound = (
  sizeBytes: number,
  fileCount: number
): number => {
  checkedInteger(
    sizeBytes,
    "Declared logical size",
    MAX_APP_TREE_LOGICAL_BYTES
  );
  checkedInteger(fileCount, "Declared file count", MAX_APP_TREE_RECORDS, false);
  const allowance = Math.min(
    MAX_APP_TREE_METADATA_BYTES,
    BASE_METADATA_BYTES + fileCount * METADATA_BYTES_PER_FILE
  );
  return sizeBytes + allowance;
};

const decodeUtf8 = (bytes: Buffer, description: string): string => {
  let decoded: string;
  try {
    decoded = textDecoder.decode(bytes);
  } catch {
    throw new Error(`${description} is not valid canonical UTF-8`);
  }
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error(`${description} is not shortest-form UTF-8`);
  }
  return decoded;
};

const validatePath = (bytes: Buffer): string => {
  if (bytes.length === 0 || bytes.length > MAX_APP_TREE_PATH_BYTES) {
    throw new Error("App-tree path length is outside the limit");
  }
  const value = decodeUtf8(bytes, "App-tree path");
  if (
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    throw new Error("App-tree path is not canonical NFC POSIX syntax");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error("App-tree path contains a traversal segment");
  }
  return value;
};

const validateSymlinkTarget = (bytes: Buffer, linkPath: string): string => {
  if (bytes.length === 0 || bytes.length > MAX_APP_TREE_PATH_BYTES) {
    throw new Error("App-tree symlink target length is outside the limit");
  }
  const value = decodeUtf8(bytes, "App-tree symlink target");
  if (
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    throw new Error(
      "App-tree symlink target is not canonical NFC POSIX syntax"
    );
  }

  const segments = value.split("/");
  let leadingParents = 0;
  while (segments[leadingParents] === "..") leadingParents += 1;
  if (
    segments.some((segment, index) =>
      index < leadingParents
        ? segment !== ".."
        : segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error("App-tree symlink target is not canonical");
  }

  const resolved = linkPath.split("/").slice(0, -1);
  for (let index = 0; index < leadingParents; index += 1) {
    if (resolved.length === 0) {
      throw new Error("App-tree symlink target escapes the artifact root");
    }
    resolved.pop();
  }
  return value;
};

const writeAll = (descriptor: number, data: Buffer): void => {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(
      descriptor,
      data,
      offset,
      data.length - offset
    );
    if (written === 0)
      throw new Error("Unable to make app-tree write progress");
    offset += written;
  }
};

const writeRecordHeader = (
  descriptor: number,
  type: number,
  pathBytes: Buffer,
  mode: number,
  dataLength: number
): number => {
  const headerLength = 1 + 4 + pathBytes.length + 4 + 8;
  if (headerLength > MAX_APP_TREE_HEADER_BYTES) {
    throw new Error("App-tree record header exceeds its limit");
  }
  const header = Buffer.allocUnsafe(headerLength);
  let offset = 0;
  header.writeUInt8(type, offset);
  offset += 1;
  header.writeUInt32BE(pathBytes.length, offset);
  offset += 4;
  pathBytes.copy(header, offset);
  offset += pathBytes.length;
  header.writeUInt32BE(mode, offset);
  offset += 4;
  header.writeBigUInt64BE(BigInt(dataLength), offset);
  writeAll(descriptor, header);
  return header.length;
};

const assertDeadline = (deadlineMs?: number): void => {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new Error("App-tree encoding exceeded its deadline");
  }
};

const collectSourceRecords = (
  sourceRoot: string,
  deadlineMs?: number
): SourceRecord[] => {
  assertDeadline(deadlineMs);
  const rootStats = fs.lstatSync(sourceRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("App-tree source root must be a real directory");
  }

  const records: SourceRecord[] = [];
  let collectedHeaderBytes = 0;
  const visit = (
    absoluteDirectory: string,
    relativeDirectory: string
  ): void => {
    assertDeadline(deadlineMs);
    const names = fs.readdirSync(absoluteDirectory, { encoding: "buffer" });
    for (const nameBytes of names) {
      assertDeadline(deadlineMs);
      const name = decodeUtf8(nameBytes, "App-tree source name");
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const pathBytes = Buffer.from(relativePath, "utf8");
      const canonicalPath = validatePath(pathBytes);
      if (canonicalPath !== relativePath) {
        throw new Error("App-tree source path is not canonical");
      }
      const absolutePath = path.join(absoluteDirectory, name);
      const stats = fs.lstatSync(absolutePath);
      collectedHeaderBytes += 1 + 4 + pathBytes.length + 4 + 8;
      if (collectedHeaderBytes > MAX_APP_TREE_METADATA_BYTES) {
        throw new Error("App-tree source metadata exceeds its hard limit");
      }
      records.push({
        absolutePath,
        path: canonicalPath,
        pathBytes,
        stats,
      });
      if (records.length > MAX_APP_TREE_RECORDS) {
        throw new Error("App-tree source has too many records");
      }
      if (stats.isDirectory()) visit(absolutePath, canonicalPath);
    }
  };
  visit(sourceRoot, "");
  records.sort((left, right) => {
    assertDeadline(deadlineMs);
    return Buffer.compare(left.pathBytes, right.pathBytes);
  });
  const aliases = new Map<string, string>();
  for (let index = 1; index < records.length; index += 1) {
    if (
      Buffer.compare(
        records[index - 1]!.pathBytes,
        records[index]!.pathBytes
      ) >= 0
    ) {
      throw new Error("App-tree source contains canonical path aliases");
    }
  }
  for (const record of records) {
    assertDeadline(deadlineMs);
    const aliasKey = filesystemAliasKey(record.path);
    const aliasedPath = aliases.get(aliasKey);
    if (aliasedPath !== undefined && aliasedPath !== record.path) {
      throw new Error("App-tree source contains filesystem path aliases");
    }
    aliases.set(aliasKey, record.path);
  }
  return records;
};

const openNoFollow = (
  candidate: string,
  flags: number,
  mode?: number
): number => fs.openSync(candidate, flags | fs.constants.O_NOFOLLOW, mode);

export const encodeAppTree = async (
  sourceRoot: string,
  archivePath: string,
  options: { deadlineMs?: number } = {}
): Promise<AppTreeArchiveStats> => {
  const records = collectSourceRecords(sourceRoot, options.deadlineMs);
  let sizeBytes = 0;
  let fileCount = 0;
  for (const record of records) {
    assertDeadline(options.deadlineMs);
    if (record.stats.isFile()) {
      checkedInteger(
        record.stats.size,
        "App-tree source file size",
        MAX_APP_TREE_LOGICAL_BYTES
      );
      if (sizeBytes + record.stats.size > MAX_APP_TREE_LOGICAL_BYTES) {
        throw new Error("App-tree source exceeds the logical size limit");
      }
      sizeBytes += record.stats.size;
      fileCount += 1;
    } else if (!record.stats.isDirectory() && !record.stats.isSymbolicLink()) {
      throw new Error(`Unsupported app-tree source entry: ${record.path}`);
    }
  }
  if (fileCount === 0) {
    throw new Error("App-tree source must contain at least one regular file");
  }
  const archiveBound = appTreeArchiveBound(sizeBytes, fileCount);
  const descriptor = openNoFollow(
    archivePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  let archiveBytes = 0;
  let completed = false;
  try {
    writeAll(descriptor, MAGIC);
    archiveBytes += MAGIC.length;
    for (const record of records) {
      assertDeadline(options.deadlineMs);
      const mode = record.stats.mode & 0o7777;
      if (record.stats.isDirectory()) {
        if (
          archiveBytes + 1 + 4 + record.pathBytes.length + 4 + 8 + 1 >
          archiveBound
        ) {
          throw new Error("App-tree archive exceeds its metadata allowance");
        }
        archiveBytes += writeRecordHeader(
          descriptor,
          DIRECTORY,
          record.pathBytes,
          mode,
          0
        );
        continue;
      }
      if (record.stats.isSymbolicLink()) {
        if (mode !== 0o777 && typeof fs.lchmodSync !== "function") {
          throw new Error(
            "App-tree source symlink mode cannot be restored on this platform"
          );
        }
        const targetBytes = fs.readlinkSync(record.absolutePath, {
          encoding: "buffer",
        });
        validateSymlinkTarget(targetBytes, record.path);
        if (
          archiveBytes +
            1 +
            4 +
            record.pathBytes.length +
            4 +
            8 +
            targetBytes.length +
            1 >
          archiveBound
        ) {
          throw new Error("App-tree archive exceeds its metadata allowance");
        }
        archiveBytes += writeRecordHeader(
          descriptor,
          SYMLINK,
          record.pathBytes,
          mode,
          targetBytes.length
        );
        writeAll(descriptor, targetBytes);
        archiveBytes += targetBytes.length;
        continue;
      }
      if (!record.stats.isFile()) {
        throw new Error(`Unsupported app-tree source entry: ${record.path}`);
      }
      if (
        archiveBytes +
          1 +
          4 +
          record.pathBytes.length +
          4 +
          8 +
          record.stats.size +
          1 >
        archiveBound
      ) {
        throw new Error("App-tree archive exceeds its metadata allowance");
      }
      archiveBytes += writeRecordHeader(
        descriptor,
        FILE,
        record.pathBytes,
        mode,
        record.stats.size
      );

      const input = openNoFollow(record.absolutePath, fs.constants.O_RDONLY);
      try {
        const openedStats = fs.fstatSync(input);
        if (
          !openedStats.isFile() ||
          openedStats.size !== record.stats.size ||
          (openedStats.mode & 0o7777) !== mode
        ) {
          throw new Error("App-tree source changed during encoding");
        }
        const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
        let remaining = record.stats.size;
        while (remaining > 0) {
          assertDeadline(options.deadlineMs);
          const read = fs.readSync(
            input,
            buffer,
            0,
            Math.min(buffer.length, remaining),
            null
          );
          if (read === 0) {
            throw new Error(
              "App-tree source file ended before its declaration"
            );
          }
          writeAll(descriptor, buffer.subarray(0, read));
          remaining -= read;
          archiveBytes += read;
        }
        const finalByte = Buffer.allocUnsafe(1);
        if (fs.readSync(input, finalByte, 0, 1, null) !== 0) {
          throw new Error("App-tree source file grew during encoding");
        }
      } finally {
        fs.closeSync(input);
      }
    }
    writeAll(descriptor, Buffer.from([END]));
    assertDeadline(options.deadlineMs);
    archiveBytes += 1;
    if (archiveBytes > archiveBound) {
      throw new Error("App-tree archive exceeds its metadata allowance");
    }
    completed = true;
    return { archiveBytes, sizeBytes, fileCount, recordCount: records.length };
  } finally {
    fs.closeSync(descriptor);
    if (!completed) {
      try {
        fs.unlinkSync(archivePath);
      } catch {}
    }
  }
};

class ArchiveReader {
  private offset = 0;

  constructor(
    private readonly descriptor: number,
    readonly size: number,
    private readonly deadlineMs?: number
  ) {}

  get bytesRead(): number {
    return this.offset;
  }

  read(length: number): Buffer {
    if (this.deadlineMs !== undefined && Date.now() >= this.deadlineMs) {
      throw new Error("App-tree extraction exceeded its deadline");
    }
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.size
    ) {
      throw new Error("App-tree archive is truncated or has an unsafe length");
    }
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (this.deadlineMs !== undefined && Date.now() >= this.deadlineMs) {
        throw new Error("App-tree extraction exceeded its deadline");
      }
      const count = fs.readSync(
        this.descriptor,
        result,
        written,
        length - written,
        this.offset + written
      );
      if (count === 0) throw new Error("App-tree archive is truncated");
      written += count;
    }
    this.offset += length;
    return result;
  }

  copyTo(descriptor: number, length: number): void {
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.read(Math.min(IO_BUFFER_BYTES, remaining));
      writeAll(descriptor, chunk);
      remaining -= chunk.length;
    }
  }
}

const prepareDestination = (
  destinationRoot: string,
  deadlineMs?: number
): void => {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new Error("App-tree extraction exceeded its deadline");
  }
  try {
    const stats = fs.lstatSync(destinationRoot);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      fs.readdirSync(destinationRoot).length !== 0
    ) {
      throw new Error(
        "App-tree destination must be absent or an empty real directory"
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(destinationRoot, { mode: 0o700 });
  }
};

const validateParentDirectories = (
  destinationRoot: string,
  relativePath: string,
  deadlineMs?: number
): string => {
  let current = destinationRoot;
  const rootStats = fs.lstatSync(current);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("App-tree extraction root is not a real directory");
  }
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new Error("App-tree extraction exceeded its deadline");
    }
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("App-tree record parent is not a real directory");
    }
  }
  return path.join(destinationRoot, ...segments);
};

const filesystemAliasKey = (relativePath: string): string =>
  relativePath.normalize("NFD").toLocaleLowerCase("en-US");

const applyDirectoryMode = (directoryPath: string, mode: number): void => {
  const descriptor = openNoFollow(directoryPath, fs.constants.O_RDONLY);
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isDirectory()) {
      throw new Error("App-tree directory changed before mode restoration");
    }
    fs.fchmodSync(descriptor, mode);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const extractAppTree = async (
  archivePath: string,
  destinationRoot: string,
  declarations: AppTreeDeclarations,
  options: { deadlineMs?: number } = {}
): Promise<AppTreeArchiveStats> => {
  const assertExtractionDeadline = (): void => {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      throw new Error("App-tree extraction exceeded its deadline");
    }
  };
  assertExtractionDeadline();
  const sizeBytes = checkedInteger(
    declarations.sizeBytes,
    "Declared logical size",
    MAX_APP_TREE_LOGICAL_BYTES
  );
  const fileCount = checkedInteger(
    declarations.fileCount,
    "Declared file count",
    MAX_APP_TREE_RECORDS,
    false
  );
  const hardArchiveBound = appTreeArchiveBound(sizeBytes, fileCount);
  const maxArchiveBytes = declarations.maxArchiveBytes ?? hardArchiveBound;
  checkedInteger(
    maxArchiveBytes,
    "Declared archive bound",
    hardArchiveBound,
    false
  );

  const descriptor = openNoFollow(archivePath, fs.constants.O_RDONLY);
  try {
    const archiveStats = fs.fstatSync(descriptor);
    if (
      !archiveStats.isFile() ||
      archiveStats.size <= MAGIC.length ||
      archiveStats.size > maxArchiveBytes
    ) {
      throw new Error("App-tree archive is not a bounded regular file");
    }
    const reader = new ArchiveReader(
      descriptor,
      archiveStats.size,
      options.deadlineMs
    );
    if (!reader.read(MAGIC.length).equals(MAGIC)) {
      throw new Error("App-tree archive has invalid magic");
    }
    prepareDestination(destinationRoot, options.deadlineMs);

    let previousPath: Buffer | null = null;
    let decodedSize = 0;
    let decodedFiles = 0;
    let recordCount = 0;
    const nodeTypes = new Map<string, number>();
    const aliases = new Map<string, string>();
    const directoryModes: Array<{
      path: string;
      relativePath: string;
      mode: number;
    }> = [];

    while (true) {
      assertExtractionDeadline();
      const type = reader.read(1).readUInt8(0);
      if (type === END) {
        if (reader.bytesRead !== reader.size) {
          throw new Error("App-tree archive has bytes after its end marker");
        }
        break;
      }
      if (type !== DIRECTORY && type !== FILE && type !== SYMLINK) {
        throw new Error("App-tree archive contains an unsupported record type");
      }
      recordCount += 1;
      if (recordCount > MAX_APP_TREE_RECORDS) {
        throw new Error("App-tree archive has too many records");
      }
      const pathLength = reader.read(4).readUInt32BE(0);
      if (1 + 4 + pathLength + 4 + 8 > MAX_APP_TREE_HEADER_BYTES) {
        throw new Error("App-tree record header exceeds its limit");
      }
      const pathBytes = reader.read(pathLength);
      const relativePath = validatePath(pathBytes);
      if (previousPath && Buffer.compare(previousPath, pathBytes) >= 0) {
        throw new Error("App-tree record paths are duplicate or out of order");
      }
      previousPath = Buffer.from(pathBytes);

      const mode = reader.read(4).readUInt32BE(0);
      if (mode > 0o7777) {
        throw new Error("App-tree record has an invalid mode");
      }
      if (
        type === SYMLINK &&
        mode !== 0o777 &&
        typeof fs.lchmodSync !== "function"
      ) {
        throw new Error(
          "App-tree symlink mode cannot be restored on this platform"
        );
      }
      const dataLengthBigInt = reader.read(8).readBigUInt64BE(0);
      if (dataLengthBigInt > MAX_SAFE_BIGINT) {
        throw new Error("App-tree record length exceeds safe integer range");
      }
      const dataLength = Number(dataLengthBigInt);
      if (type === DIRECTORY && dataLength !== 0) {
        throw new Error("App-tree directory record contains data");
      }
      if (type === FILE) {
        if (
          dataLength > MAX_APP_TREE_LOGICAL_BYTES ||
          decodedSize + dataLength > sizeBytes ||
          decodedFiles + 1 > fileCount
        ) {
          throw new Error("App-tree file data exceeds its declaration");
        }
      }
      if (type === SYMLINK && dataLength > MAX_APP_TREE_PATH_BYTES) {
        throw new Error("App-tree symlink target exceeds its limit");
      }

      const parent = path.posix.dirname(relativePath);
      if (parent !== "." && nodeTypes.get(parent) !== DIRECTORY) {
        throw new Error("App-tree record is missing a directory parent");
      }
      const aliasKey = filesystemAliasKey(relativePath);
      const aliasedPath = aliases.get(aliasKey);
      if (aliasedPath !== undefined && aliasedPath !== relativePath) {
        throw new Error("App-tree record aliases an existing filesystem path");
      }
      aliases.set(aliasKey, relativePath);

      const outputPath = validateParentDirectories(
        destinationRoot,
        relativePath,
        options.deadlineMs
      );
      if (type === DIRECTORY) {
        fs.mkdirSync(outputPath, { mode: 0o700 });
        directoryModes.push({ path: outputPath, relativePath, mode });
      } else if (type === FILE) {
        const output = openNoFollow(
          outputPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600
        );
        try {
          reader.copyTo(output, dataLength);
          const outputStats = fs.fstatSync(output);
          if (!outputStats.isFile() || outputStats.size !== dataLength) {
            throw new Error("App-tree file extraction size mismatch");
          }
          fs.fchmodSync(output, mode);
        } finally {
          fs.closeSync(output);
        }
        decodedSize += dataLength;
        decodedFiles += 1;
      } else {
        const targetBytes = reader.read(dataLength);
        const target = validateSymlinkTarget(targetBytes, relativePath);
        fs.symlinkSync(target, outputPath);
        if (typeof fs.lchmodSync === "function") {
          fs.lchmodSync(outputPath, mode);
        } else if (mode !== 0o777) {
          throw new Error(
            "App-tree symlink mode cannot be restored on this platform"
          );
        }
        const outputStats = fs.lstatSync(outputPath);
        if (
          !outputStats.isSymbolicLink() ||
          (outputStats.mode & 0o7777) !== mode ||
          fs.readlinkSync(outputPath) !== target
        ) {
          throw new Error(
            "App-tree symlink extraction did not reproduce its target"
          );
        }
      }
      nodeTypes.set(relativePath, type);
    }

    if (decodedSize !== sizeBytes || decodedFiles !== fileCount) {
      throw new Error("App-tree archive does not match its exact declarations");
    }
    directoryModes.sort((left, right) => {
      assertExtractionDeadline();
      return (
        right.path.split(path.sep).length - left.path.split(path.sep).length
      );
    });
    for (const directory of directoryModes) {
      assertExtractionDeadline();
      validateParentDirectories(
        destinationRoot,
        directory.relativePath,
        options.deadlineMs
      );
      applyDirectoryMode(directory.path, directory.mode);
    }
    assertExtractionDeadline();
    return {
      archiveBytes: archiveStats.size,
      sizeBytes: decodedSize,
      fileCount: decodedFiles,
      recordCount,
    };
  } finally {
    fs.closeSync(descriptor);
  }
};
