import * as childProcess from "child_process";
import * as fs from "fs";
import { Transform, type TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import * as zlib from "zlib";

export const MAX_COMPRESSED_BYTES = 100 * 1024 ** 3;
export const MAX_LOGICAL_BYTES = 100 * 1024 ** 3;
export const ZSTD_WINDOW_LOG_MAX = 27;
export const ZSTD_MEMORY_LIMIT = "128MB";
const INACTIVITY_TIMEOUT_MS = 60_000;
const MIN_WALL_TIMEOUT_MS = 120_000;
const MAX_WALL_TIMEOUT_MS = 30 * 60_000;
const DIAGNOSTIC_LIMIT = 64 * 1024;

export type CodecOperationOptions = {
  maxOutputBytes: number;
  logicalSizeBytes: number;
};

export type ZstdCodec = {
  kind: "node" | "cli";
  encode(
    inputPath: string,
    outputPath: string,
    options: CodecOperationOptions
  ): Promise<void>;
  decode(
    inputPath: string,
    outputPath: string,
    options: CodecOperationOptions
  ): Promise<void>;
};

type ZstdFactory = (
  options?: Record<string, unknown>
) => NodeJS.ReadWriteStream;

const checkedLimit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LOGICAL_BYTES) {
    throw new Error(`${name} exceeds the zstd operation limit`);
  }
  return value;
};

const wallTimeoutMs = (logicalSizeBytes: number): number =>
  Math.min(
    MAX_WALL_TIMEOUT_MS,
    Math.max(
      MIN_WALL_TIMEOUT_MS,
      Math.ceil(logicalSizeBytes / 1024 ** 3) * MIN_WALL_TIMEOUT_MS
    )
  );

class ProgressLimitTransform extends Transform {
  private bytes = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxBytes: number,
    private readonly onInactivity: () => void
  ) {
    super();
    this.resetInactivity();
  }

  private resetInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(this.onInactivity, INACTIVITY_TIMEOUT_MS);
    this.inactivityTimer.unref?.();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error("Zstd output exceeds its declared limit"));
      return;
    }
    this.resetInactivity();
    callback(null, chunk);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    callback(error);
  }
}

const runNodeCodec = async (
  factory: ZstdFactory,
  inputPath: string,
  outputPath: string,
  options: CodecOperationOptions,
  codecOptions: Record<string, unknown>
): Promise<void> => {
  const maxOutputBytes = checkedLimit(options.maxOutputBytes, "maxOutputBytes");
  const logicalSizeBytes = checkedLimit(
    options.logicalSizeBytes,
    "logicalSizeBytes"
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Zstd operation timed out")),
    wallTimeoutMs(logicalSizeBytes)
  );
  timer.unref?.();
  const codec = factory(codecOptions);
  const limiter = new ProgressLimitTransform(maxOutputBytes, () =>
    controller.abort(new Error("Zstd operation became inactive"))
  );
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      codec,
      limiter,
      fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
};

const getNodeCodec = (): ZstdCodec | null => {
  const dynamic = zlib as unknown as Record<string, unknown>;
  const createCompress = dynamic.createZstdCompress;
  const createDecompress = dynamic.createZstdDecompress;
  if (
    typeof createCompress !== "function" ||
    typeof createDecompress !== "function"
  ) {
    return null;
  }
  const constants = zlib.constants as unknown as Record<string, number>;
  const compressionLevel = constants.ZSTD_c_compressionLevel;
  const checksumFlag = constants.ZSTD_c_checksumFlag;
  const windowLogMax = constants.ZSTD_d_windowLogMax;
  if (
    typeof compressionLevel !== "number" ||
    typeof checksumFlag !== "number" ||
    typeof windowLogMax !== "number"
  ) {
    return null;
  }

  return {
    kind: "node",
    encode: (inputPath, outputPath, options) =>
      runNodeCodec(
        createCompress as ZstdFactory,
        inputPath,
        outputPath,
        options,
        { params: { [compressionLevel]: 3, [checksumFlag]: 1 } }
      ),
    decode: (inputPath, outputPath, options) =>
      runNodeCodec(
        createDecompress as ZstdFactory,
        inputPath,
        outputPath,
        options,
        { params: { [windowLogMax]: ZSTD_WINDOW_LOG_MAX } }
      ),
  };
};

const runCliCodec = async (
  arguments_: string[],
  inputPath: string,
  outputPath: string,
  options: CodecOperationOptions
): Promise<void> => {
  const maxOutputBytes = checkedLimit(options.maxOutputBytes, "maxOutputBytes");
  const logicalSizeBytes = checkedLimit(
    options.logicalSizeBytes,
    "logicalSizeBytes"
  );
  const child = childProcess.spawn("zstd", arguments_, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  let diagnostics = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    if (diagnostics.length < DIAGNOSTIC_LIMIT) {
      diagnostics = Buffer.concat([
        diagnostics,
        chunk.subarray(0, DIAGNOSTIC_LIMIT - diagnostics.length),
      ]);
    }
  });
  let abortReason: Error | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const abort = (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    abortReason ??= error;
    if (!controller.signal.aborted) controller.abort(error);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        killTimer.unref?.();
      }
    }
    child.stdout.destroy(error);
    child.stdin.destroy(error);
  };
  const wallTimer = setTimeout(
    () => abort(new Error("Zstd operation timed out")),
    wallTimeoutMs(logicalSizeBytes)
  );
  wallTimer.unref?.();
  const limiter = new ProgressLimitTransform(maxOutputBytes, () =>
    abort(new Error("Zstd operation became inactive"))
  );
  const exited = new Promise<void>((resolve, reject) => {
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (spawnError) {
        reject(spawnError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `zstd exited with ${signal ?? code}: ${diagnostics
              .toString("utf8")
              .trim()
              .slice(0, 512)}`
          )
        );
      }
    });
  });

  const observe = async (operation: Promise<void>): Promise<void> => {
    try {
      await operation;
    } catch (error) {
      abort(error);
      throw error;
    }
  };

  const operations = [
    observe(
      pipeline(fs.createReadStream(inputPath), child.stdin, {
        signal: controller.signal,
      })
    ),
    observe(
      pipeline(
        child.stdout,
        limiter,
        fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal }
      )
    ),
    observe(exited),
  ];
  try {
    const results = await Promise.allSettled(operations);
    if (abortReason) throw abortReason;
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
  } finally {
    clearTimeout(wallTimer);
    if (killTimer) clearTimeout(killTimer);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
};

const getCliCodec = (): ZstdCodec | null => {
  const probe = childProcess.spawnSync("zstd", ["-V"], {
    shell: false,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: DIAGNOSTIC_LIMIT,
  });
  if (probe.status !== 0) return null;
  return {
    kind: "cli",
    encode: (inputPath, outputPath, options) =>
      runCliCodec(
        ["-3", "--check", "-q", "-c"],
        inputPath,
        outputPath,
        options
      ),
    decode: (inputPath, outputPath, options) =>
      runCliCodec(
        ["-d", "--check", "-q", "-c", `-M${ZSTD_MEMORY_LIMIT}`],
        inputPath,
        outputPath,
        options
      ),
  };
};

let cachedCodec: ZstdCodec | null | undefined;

export const discoverZstdCodec = (): ZstdCodec | null => {
  if (cachedCodec !== undefined) return cachedCodec;
  cachedCodec = getNodeCodec() ?? getCliCodec();
  return cachedCodec;
};

export const resetZstdCodecCacheForTests = (): void => {
  cachedCodec = undefined;
};
