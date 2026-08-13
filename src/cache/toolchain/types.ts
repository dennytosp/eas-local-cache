import type * as fs from "fs";

import type { CachePlatform } from "../paths";

export const COMMAND_TIMEOUT_MS = 2_000;
export const DISCOVERY_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_WRAPPER_BYTES = 64 * 1024;
export const MAX_ANDROID_CONFIGURATION_BYTES = 1024 * 1024;
export const MAX_ANDROID_PACKAGE_PROPERTIES_BYTES = 64 * 1024;
export const MAX_TOKEN_LENGTH = 128;

export type ToolchainMode = "safe" | "strict";
export type HostArchitecture = "arm64" | "x86_64" | "x86" | "arm";
export type JvmArchitecture = HostArchitecture;
export type JavaVendorFamily =
  | "adoptium"
  | "amazon"
  | "azul"
  | "microsoft"
  | "oracle"
  | "other";
export type JavaVmFamily = "hotspot" | "openj9" | "graalvm" | "other";
export type AndroidTargetArchitecture =
  | "all"
  | "arm64-v8a"
  | "armeabi-v7a"
  | "x86"
  | "x86_64";

export type IosToolchainSnapshot = {
  platform: "ios";
  hostArch: HostArchitecture;
  xcodeBuildVersion: string;
  simulatorSdkBuildVersion: string;
  xcodeVersion?: string;
  simulatorSdkVersion?: string;
};

export type AndroidToolchainSnapshot = {
  platform: "android";
  hostArch: HostArchitecture;
  compileSdkVersion?: string;
  androidSdkPlatformRevision?: string;
  buildToolsVersion?: string;
  javaSpecificationVersion: string;
  javaVendorFamily: JavaVendorFamily;
  jvmArch: JvmArchitecture;
  gradleVersion: string;
  targetArchitecture: AndroidTargetArchitecture;
  javaRuntimeVersion?: string;
  vmFamily?: JavaVmFamily;
  gradleDistributionBasename?: string;
  gradleDistributionSha256?: string;
};

export type ToolchainSnapshot = IosToolchainSnapshot | AndroidToolchainSnapshot;

export type ToolchainCommandRequest = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ToolchainCommandResult = { stdout: string; stderr: string };
export type ToolchainCommandRunner = (
  request: ToolchainCommandRequest
) => Promise<ToolchainCommandResult>;
export type ToolchainModuleResolver = (
  specifier: string,
  projectRoot: string
) => string;

export type ToolchainFileSystem = {
  openSync(filename: string, flags: number): number;
  fstatSync(descriptor: number): Pick<fs.Stats, "isFile" | "size">;
  readFileSync(descriptor: number, encoding: "utf8"): string;
  closeSync(descriptor: number): void;
};

export type ToolchainDiscoveryReason =
  | "command-failed"
  | "discovery-timeout"
  | "invalid-run-profile"
  | "malformed-output"
  | "missing-sdk"
  | "missing-wrapper"
  | "target-ambiguous"
  | "target-unavailable"
  | "unsupported-abi";

export type ToolchainDiscoveryResult =
  | { status: "available"; snapshot: ToolchainSnapshot }
  | { status: "unavailable"; reason: ToolchainDiscoveryReason };

export type ToolchainDiscoveryRequest = {
  projectRoot: string;
  platform: CachePlatform;
  runOptions: unknown;
  mode: ToolchainMode;
  runner?: ToolchainCommandRunner;
  fileSystem?: ToolchainFileSystem;
  moduleResolver?: ToolchainModuleResolver;
  env?: NodeJS.ProcessEnv;
  hostArch?: string;
};
