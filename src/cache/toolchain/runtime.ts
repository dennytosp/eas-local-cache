import { execFile } from "child_process";
import * as fs from "fs";
import { createRequire } from "module";
import * as path from "path";

import {
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TOKEN_LENGTH,
  type HostArchitecture,
  type ToolchainCommandRunner,
  type ToolchainFileSystem,
  type ToolchainModuleResolver,
} from "./types";

export const runToolchainCommand: ToolchainCommandRunner = (request) =>
  new Promise((resolve, reject) => {
    execFile(
      request.command,
      [...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes + 1,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error("Toolchain command failed"));
          return;
        }
        const output = `${stdout}${stderr}`;
        if (Buffer.byteLength(output) > request.maxOutputBytes) {
          reject(new Error("Toolchain command output exceeded its limit"));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const boundedToken = (value: string, pattern: RegExp): string | null => {
  const token = value.trim();
  return token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH &&
    pattern.test(token)
    ? token
    : null;
};

export const isBoundedSelector = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 256 &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

export const normalizeArchitecture = (
  value: string
): HostArchitecture | null => {
  switch (value.trim().toLowerCase()) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
    case "amd64":
      return "x86_64";
    case "ia32":
    case "i386":
    case "i686":
    case "x86":
      return "x86";
    case "arm":
    case "armv7":
    case "armv7l":
      return "arm";
    default:
      return null;
  }
};

export const command = (
  runner: ToolchainCommandRunner,
  executable: string,
  args: readonly string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv
) =>
  runner({
    command: executable,
    args,
    cwd: projectRoot,
    env,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });

export const nodeFileSystem: ToolchainFileSystem = {
  openSync: (filename, flags) => fs.openSync(filename, flags),
  fstatSync: (descriptor) => fs.fstatSync(descriptor),
  readFileSync: (descriptor, encoding) => fs.readFileSync(descriptor, encoding),
  closeSync: (descriptor) => fs.closeSync(descriptor),
};

export const resolveProjectModule: ToolchainModuleResolver = (
  specifier,
  projectRoot
) => createRequire(path.join(projectRoot, "package.json")).resolve(specifier);
