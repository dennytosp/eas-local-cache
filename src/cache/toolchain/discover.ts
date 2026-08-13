import { discoverAndroid } from "./android";
import { discoverIos } from "./ios";
import {
  nodeFileSystem,
  isRecord,
  normalizeArchitecture,
  resolveProjectModule,
  runToolchainCommand,
} from "./runtime";
import type {
  ToolchainDiscoveryReason,
  ToolchainDiscoveryRequest,
  ToolchainDiscoveryResult,
} from "./types";
import { DISCOVERY_TIMEOUT_MS } from "./types";

const reasonForError = (error: unknown): ToolchainDiscoveryReason => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("target unavailable")) return "target-unavailable";
  if (message.includes("target ambiguous")) return "target-ambiguous";
  if (message.includes("target selector")) return "invalid-run-profile";
  if (message.includes("Unsupported Android ABI")) return "unsupported-abi";
  if (message.startsWith("Missing Android SDK")) return "missing-sdk";
  if (
    message.includes("wrapper") ||
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
  )
    return "missing-wrapper";
  if (
    message.includes("Malformed") ||
    message.includes("Invalid") ||
    message.includes("Conflicting") ||
    message.includes("build configuration") ||
    message.includes("bounded toolchain file")
  )
    return "malformed-output";
  return "command-failed";
};

export const discoverToolchain = async ({
  projectRoot,
  platform,
  runOptions,
  mode,
  runner = runToolchainCommand,
  fileSystem = nodeFileSystem,
  moduleResolver = resolveProjectModule,
  env = process.env,
  hostArch = process.arch,
}: ToolchainDiscoveryRequest): Promise<ToolchainDiscoveryResult> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (
      platform === "ios" &&
      isRecord(runOptions) &&
      runOptions.scheme === true
    ) {
      return { status: "unavailable", reason: "invalid-run-profile" };
    }
    const normalizedHostArch = normalizeArchitecture(hostArch);
    if (!normalizedHostArch) {
      return { status: "unavailable", reason: "malformed-output" };
    }
    const discovery =
      platform === "ios"
        ? discoverIos(projectRoot, mode, runner, env, normalizedHostArch)
        : discoverAndroid(
            projectRoot,
            runOptions,
            mode,
            runner,
            env,
            normalizedHostArch,
            fileSystem,
            moduleResolver
          );
    const snapshot = await Promise.race([
      discovery,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Discovery timeout")),
          DISCOVERY_TIMEOUT_MS
        );
      }),
    ]);
    return { status: "available", snapshot };
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error && error.message === "Discovery timeout"
          ? "discovery-timeout"
          : reasonForError(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
