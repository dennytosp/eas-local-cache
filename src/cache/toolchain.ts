import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { createRequire } from "module";

import type { CachePlatform } from "./paths";

const COMMAND_TIMEOUT_MS = 2_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_WRAPPER_BYTES = 64 * 1024;
const MAX_ANDROID_CONFIGURATION_BYTES = 1024 * 1024;
const MAX_ANDROID_PACKAGE_PROPERTIES_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 128;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedToken = (value: string, pattern: RegExp): string | null => {
  const token = value.trim();
  return token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH &&
    pattern.test(token)
    ? token
    : null;
};

const isBoundedSelector = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 256 &&
  !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const normalizeArchitecture = (value: string): HostArchitecture | null => {
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

const command = (
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

const nodeFileSystem: ToolchainFileSystem = {
  openSync: (filename, flags) => fs.openSync(filename, flags),
  fstatSync: (descriptor) => fs.fstatSync(descriptor),
  readFileSync: (descriptor, encoding) => fs.readFileSync(descriptor, encoding),
  closeSync: (descriptor) => fs.closeSync(descriptor),
};

const resolveProjectModule: ToolchainModuleResolver = (
  specifier,
  projectRoot
) => createRequire(path.join(projectRoot, "package.json")).resolve(specifier);

const discoverIos = async (
  projectRoot: string,
  mode: ToolchainMode,
  runner: ToolchainCommandRunner,
  env: NodeJS.ProcessEnv,
  hostArch: HostArchitecture
): Promise<IosToolchainSnapshot> => {
  const [xcode, sdkBuild, sdkVersion] = await Promise.all([
    command(runner, "xcodebuild", ["-version"], projectRoot, env),
    command(
      runner,
      "xcrun",
      ["--sdk", "iphonesimulator", "--show-sdk-build-version"],
      projectRoot,
      env
    ),
    mode === "strict"
      ? command(
          runner,
          "xcrun",
          ["--sdk", "iphonesimulator", "--show-sdk-version"],
          projectRoot,
          env
        )
      : Promise.resolve(null),
  ]);
  const xcodeText = `${xcode.stdout}\n${xcode.stderr}`;
  const xcodeVersion = boundedToken(
    xcodeText.match(/^Xcode\s+([^\s]+)\s*$/m)?.[1] ?? "",
    /^[0-9A-Za-z.+-]+$/
  );
  const xcodeBuildVersion = boundedToken(
    xcodeText.match(/^Build version\s+([^\s]+)\s*$/m)?.[1] ?? "",
    /^[0-9A-Za-z.+-]+$/
  );
  const simulatorSdkBuildVersion = boundedToken(
    `${sdkBuild.stdout}${sdkBuild.stderr}`,
    /^[0-9A-Za-z.+-]+$/
  );
  const simulatorSdkVersion = sdkVersion
    ? boundedToken(
        `${sdkVersion.stdout}${sdkVersion.stderr}`,
        /^[0-9A-Za-z.+-]+$/
      )
    : null;
  if (
    !xcodeBuildVersion ||
    !simulatorSdkBuildVersion ||
    (mode === "strict" && (!xcodeVersion || !simulatorSdkVersion))
  ) {
    throw new Error("Malformed iOS toolchain output");
  }
  return {
    platform: "ios",
    hostArch,
    xcodeBuildVersion,
    simulatorSdkBuildVersion,
    ...(mode === "strict"
      ? {
          xcodeVersion: xcodeVersion!,
          simulatorSdkVersion: simulatorSdkVersion!,
        }
      : {}),
  };
};

const readBoundedRegularFile = (
  fileSystem: ToolchainFileSystem,
  filename: string,
  maximumBytes: number
): string => {
  const descriptor = fileSystem.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  try {
    const stats = fileSystem.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
      throw new Error("Invalid bounded toolchain file");
    }
    return fileSystem.readFileSync(descriptor, "utf8");
  } finally {
    fileSystem.closeSync(descriptor);
  }
};

const parsePropertyFile = (contents: string): Map<string, string> => {
  const properties = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/);
    if (match?.[1] && match[2] !== undefined) {
      properties.set(match[1], match[2].replace(/\\:/g, ":"));
    }
  }
  return properties;
};

const readWrapperProperties = (
  projectRoot: string,
  mode: ToolchainMode,
  fileSystem: ToolchainFileSystem
) => {
  const filename = path.join(
    projectRoot,
    "android",
    "gradle",
    "wrapper",
    "gradle-wrapper.properties"
  );
  const contents = readBoundedRegularFile(
    fileSystem,
    filename,
    MAX_WRAPPER_BYTES
  );
  const properties = parsePropertyFile(contents);
  const distributionUrl = properties.get("distributionUrl") ?? "";
  const basename = distributionUrl.split(/[\\/]/).pop() ?? "";
  const gradleVersion = boundedToken(
    basename.match(/^gradle-([0-9][0-9A-Za-z.+-]*)-(?:bin|all)\.zip$/)?.[1] ??
      "",
    /^[0-9A-Za-z.+-]+$/
  );
  const distributionBasename = boundedToken(
    basename,
    /^gradle-[0-9A-Za-z.+-]+-(?:bin|all)\.zip$/
  );
  const checksumValue = properties.get("distributionSha256Sum");
  const checksum = checksumValue
    ? boundedToken(checksumValue.toLowerCase(), /^[a-f0-9]{64}$/)
    : null;
  if (
    !gradleVersion ||
    !distributionBasename ||
    (mode === "strict" && checksumValue && !checksum)
  ) {
    throw new Error("Malformed Gradle wrapper properties");
  }
  return { gradleVersion, distributionBasename, checksum };
};

const optionalBoundedRegularFile = (
  fileSystem: ToolchainFileSystem,
  filename: string,
  maximumBytes: number
): string | null => {
  try {
    return readBoundedRegularFile(fileSystem, filename, maximumBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const resolveAndroidSdkRoot = (
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  fileSystem: ToolchainFileSystem
): string => {
  const androidHome = env.ANDROID_HOME?.trim();
  const androidSdkRoot = env.ANDROID_SDK_ROOT?.trim();
  if (
    androidHome &&
    androidSdkRoot &&
    path.resolve(androidHome) !== path.resolve(androidSdkRoot)
  ) {
    throw new Error("Conflicting Android SDK roots");
  }
  const configured = androidSdkRoot || androidHome;
  if (configured) return path.resolve(configured);

  const localProperties = optionalBoundedRegularFile(
    fileSystem,
    path.join(projectRoot, "android", "local.properties"),
    MAX_ANDROID_PACKAGE_PROPERTIES_BYTES
  );
  const sdkDirectory = localProperties
    ? parsePropertyFile(localProperties).get("sdk.dir")?.trim()
    : null;
  if (!sdkDirectory) throw new Error("Missing Android SDK root");
  return path.resolve(projectRoot, sdkDirectory.replace(/\\\\/g, "\\"));
};

const singleMatch = (
  contents: string,
  patterns: readonly RegExp[],
  pattern: RegExp
): string | null => {
  const matches = new Set<string>();
  for (const expression of patterns) {
    const matcher = new RegExp(
      expression.source,
      expression.flags.includes("g") ? expression.flags : `${expression.flags}g`
    );
    for (const match of contents.matchAll(matcher)) {
      const value = match[1];
      if (!value) continue;
      const token = boundedToken(value, pattern);
      if (token) matches.add(token);
    }
  }
  if (matches.size > 1)
    throw new Error("Ambiguous Android build configuration");
  return [...matches][0] ?? null;
};

const discoverAndroidBuildConfiguration = (
  projectRoot: string,
  fileSystem: ToolchainFileSystem,
  moduleResolver: ToolchainModuleResolver
): { compileSdkVersion: string; buildToolsVersion: string } | null => {
  const gradleProperties = optionalBoundedRegularFile(
    fileSystem,
    path.join(projectRoot, "android", "gradle.properties"),
    MAX_ANDROID_CONFIGURATION_BYTES
  );
  const properties = gradleProperties
    ? parsePropertyFile(gradleProperties)
    : new Map<string, string>();
  let compileSdkVersion = boundedToken(
    properties.get("android.compileSdkVersion") ?? "",
    /^[0-9]{1,3}$/
  );
  let buildToolsVersion = boundedToken(
    properties.get("android.buildToolsVersion") ?? "",
    /^[0-9][0-9A-Za-z.+-]*$/
  );

  const scripts = ["build.gradle", path.join("app", "build.gradle")]
    .map((relativePath) =>
      optionalBoundedRegularFile(
        fileSystem,
        path.join(projectRoot, "android", relativePath),
        MAX_ANDROID_CONFIGURATION_BYTES
      )
    )
    .filter((contents): contents is string => contents !== null)
    .join("\n");
  if (!compileSdkVersion || !buildToolsVersion) {
    compileSdkVersion ??= singleMatch(
      scripts,
      [
        /android\.compileSdkVersion[^\r\n]*?\?:\s*["']([0-9]{1,3})["']/,
        /\bcompileSdk(?:Version)?\s*(?:=|\s)\s*["']?([0-9]{1,3})["']?/,
      ],
      /^[0-9]{1,3}$/
    );
    buildToolsVersion ??= singleMatch(
      scripts,
      [
        /android\.buildToolsVersion[^\r\n]*?\?:\s*["']([0-9][0-9A-Za-z.+-]*)["']/,
        /\bbuildToolsVersion\s*(?:=|\s)\s*["']([0-9][0-9A-Za-z.+-]*)["']/,
      ],
      /^[0-9][0-9A-Za-z.+-]*$/
    );
  }
  if (!compileSdkVersion || !buildToolsVersion) {
    const settings = optionalBoundedRegularFile(
      fileSystem,
      path.join(projectRoot, "android", "settings.gradle"),
      MAX_ANDROID_CONFIGURATION_BYTES
    );
    const usesExpoCatalog =
      settings?.includes("expoAutolinking.useExpoVersionCatalog()") === true &&
      /apply\s+plugin:\s*["']expo-root-project["']/.test(scripts) &&
      scripts.includes("rootProject.ext.compileSdkVersion") &&
      scripts.includes("rootProject.ext.buildToolsVersion");
    if (usesExpoCatalog) {
      try {
        const reactNativePackage = moduleResolver(
          "react-native/package.json",
          projectRoot
        );
        const catalog = parseTomlVersions(
          readBoundedRegularFile(
            fileSystem,
            path.join(
              path.dirname(reactNativePackage),
              "gradle",
              "libs.versions.toml"
            ),
            MAX_ANDROID_CONFIGURATION_BYTES
          )
        );
        compileSdkVersion ??= boundedToken(
          catalog.get("compileSdk") ?? "",
          /^[0-9]{1,3}$/
        );
        buildToolsVersion ??= boundedToken(
          catalog.get("buildTools") ?? "",
          /^[0-9][0-9A-Za-z.+-]*$/
        );
      } catch {
        return null;
      }
    }
  }
  if (!compileSdkVersion || !buildToolsVersion) {
    return null;
  }
  return { compileSdkVersion, buildToolsVersion };
};

const parseTomlVersions = (contents: string): Map<string, string> => {
  const versions = new Map<string, string>();
  let inVersions = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)?.[1];
    if (section) {
      inVersions = section === "versions";
      continue;
    }
    if (!inVersions) continue;
    const match = line.match(
      /^\s*([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/
    );
    if (match?.[1] && match[2] !== undefined) {
      if (versions.has(match[1])) {
        throw new Error("Malformed Expo Android version catalog");
      }
      versions.set(match[1], match[2]);
    }
  }
  return versions;
};

const discoverInstalledAndroidPackages = (
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  fileSystem: ToolchainFileSystem,
  moduleResolver: ToolchainModuleResolver
): {
  compileSdkVersion?: string;
  androidSdkPlatformRevision?: string;
  buildToolsVersion?: string;
} => {
  const configuration = discoverAndroidBuildConfiguration(
    projectRoot,
    fileSystem,
    moduleResolver
  );
  // Expo's root-project plugin commonly supplies these values dynamically.
  // If neither value is statically knowable, retain the pre-SDK-signal key
  // shape instead of disabling otherwise-safe Android caching. When the
  // selected versions are knowable, their installed package metadata becomes
  // required and is validated below.
  if (configuration === null) return {};
  const sdkRoot = resolveAndroidSdkRoot(projectRoot, env, fileSystem);
  let platformProperties: Map<string, string>;
  let buildToolsProperties: Map<string, string>;
  try {
    platformProperties = parsePropertyFile(
      readBoundedRegularFile(
        fileSystem,
        path.join(
          sdkRoot,
          "platforms",
          `android-${configuration.compileSdkVersion}`,
          "source.properties"
        ),
        MAX_ANDROID_PACKAGE_PROPERTIES_BYTES
      )
    );
    buildToolsProperties = parsePropertyFile(
      readBoundedRegularFile(
        fileSystem,
        path.join(
          sdkRoot,
          "build-tools",
          configuration.buildToolsVersion,
          "source.properties"
        ),
        MAX_ANDROID_PACKAGE_PROPERTIES_BYTES
      )
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Missing Android SDK package");
    }
    throw error;
  }
  const platformApi = boundedToken(
    platformProperties.get("AndroidVersion.ApiLevel") ?? "",
    /^[0-9]{1,3}$/
  );
  const platformRevision = boundedToken(
    platformProperties.get("Pkg.Revision") ?? "",
    /^[0-9][0-9A-Za-z.+-]*$/
  );
  const installedBuildToolsVersion = boundedToken(
    buildToolsProperties.get("Pkg.Revision") ?? "",
    /^[0-9][0-9A-Za-z.+-]*$/
  );
  if (
    platformApi !== configuration.compileSdkVersion ||
    !platformRevision ||
    installedBuildToolsVersion !== configuration.buildToolsVersion
  ) {
    throw new Error("Malformed Android SDK package metadata");
  }
  return {
    compileSdkVersion: configuration.compileSdkVersion,
    androidSdkPlatformRevision: platformRevision,
    buildToolsVersion: configuration.buildToolsVersion,
  };
};

const parseJavaProperties = (text: string) => {
  const properties = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9.]+)\s*=\s*(.*?)\s*$/i);
    if (match?.[1] && match[2] !== undefined && match[2].length <= 256) {
      properties.set(match[1], match[2]);
    }
  }
  return properties;
};

const javaVendorFamily = (value: string): JavaVendorFamily => {
  const normalized = value.toLowerCase();
  if (normalized.includes("adoptium") || normalized.includes("temurin"))
    return "adoptium";
  if (normalized.includes("amazon") || normalized.includes("corretto"))
    return "amazon";
  if (normalized.includes("azul") || normalized.includes("zulu")) return "azul";
  if (normalized.includes("microsoft")) return "microsoft";
  if (normalized.includes("oracle")) return "oracle";
  return "other";
};

const javaVmFamily = (value: string): JavaVmFamily => {
  const normalized = value.toLowerCase();
  if (normalized.includes("openj9")) return "openj9";
  if (normalized.includes("graal")) return "graalvm";
  if (normalized.includes("hotspot") || normalized.includes("openjdk"))
    return "hotspot";
  return "other";
};

type AdbTarget = { serial: string; state: string; name: string | null };

const parseAdbTargets = (output: string): AdbTarget[] =>
  output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const match = line.match(/^([^\s]+)\s+([^\s]+)(?:\s+(.*))?$/);
      if (
        !match?.[1] ||
        !match[2] ||
        !isBoundedSelector(match[1]) ||
        !isBoundedSelector(match[2])
      )
        return null;
      const metadata = match[3] ?? "";
      const candidateName =
        metadata.match(/(?:^|\s)(?:model|device):([^\s]+)/)?.[1] ?? null;
      const name =
        candidateName && isBoundedSelector(candidateName)
          ? candidateName
          : null;
      return { serial: match[1], state: match[2], name };
    })
    .filter((target): target is AdbTarget => target !== null);

const readAvdName = async (
  target: AdbTarget,
  adb: string,
  projectRoot: string,
  runner: ToolchainCommandRunner,
  env: NodeJS.ProcessEnv
): Promise<string | null> => {
  if (!target.serial.startsWith("emulator-")) return null;
  try {
    const result = await command(
      runner,
      adb,
      ["-s", target.serial, "emu", "avd", "name"],
      projectRoot,
      env
    );
    const lines = `${result.stdout}${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "OK");
    return lines.length === 1 && isBoundedSelector(lines[0]!)
      ? lines[0]!
      : null;
  } catch {
    return null;
  }
};

const resolveAndroidTarget = async (
  projectRoot: string,
  runOptions: unknown,
  runner: ToolchainCommandRunner,
  env: NodeJS.ProcessEnv
): Promise<AndroidTargetArchitecture> => {
  const options = isRecord(runOptions) ? runOptions : {};
  const variant =
    typeof options.variant === "string" ? options.variant : "debug";
  const variantParts = variant.split(/(?=[A-Z])/);
  let buildType = variantParts.pop()?.toLowerCase() ?? "debug";
  if (buildType === "optimized") {
    buildType = `${variantParts.pop()?.toLowerCase() ?? "debug"}Optimized`;
  }
  const isTargetedDebug =
    buildType === "debug" || buildType === "debugOptimized";
  if (options.allArch === true || !isTargetedDebug) return "all";
  if (
    options.device === true ||
    (options.device !== undefined && typeof options.device !== "string")
  ) {
    throw new Error("Invalid Android target selector");
  }
  if (
    typeof options.device === "string" &&
    !isBoundedSelector(options.device)
  ) {
    throw new Error("Invalid Android target selector");
  }
  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const adb = sdkRoot ? path.join(sdkRoot, "platform-tools", "adb") : "adb";
  const devices = await command(
    runner,
    adb,
    ["devices", "-l"],
    projectRoot,
    env
  );
  const targets = parseAdbTargets(`${devices.stdout}${devices.stderr}`);
  const online = targets.filter((target) => target.state === "device");
  let selected: AdbTarget | undefined;
  if (typeof options.device === "string") {
    const selector = options.device;
    const serialMatch = targets.find((target) => target.serial === selector);
    if (serialMatch && serialMatch.state !== "device")
      throw new Error("Android target unavailable");
    if (serialMatch) selected = serialMatch;
    else {
      const nameMatches = online.filter((target) => target.name === selector);
      if (nameMatches.length === 1) selected = nameMatches[0];
      else if (nameMatches.length > 1)
        throw new Error("Android target ambiguous");
      else {
        const avdNames = await Promise.all(
          online.map(async (target) => ({
            target,
            name: await readAvdName(target, adb, projectRoot, runner, env),
          }))
        );
        const avdMatches = avdNames.filter(({ name }) => name === selector);
        if (avdMatches.length !== 1)
          throw new Error("Android target ambiguous");
        selected = avdMatches[0]!.target;
      }
    }
  } else if (online.length === 1) selected = online[0];
  else throw new Error("Android target ambiguous");
  if (!selected) throw new Error("Android target unavailable");
  const abi = await command(
    runner,
    adb,
    ["-s", selected.serial, "shell", "getprop", "ro.product.cpu.abilist"],
    projectRoot,
    env
  );
  const supported = new Set(["arm64-v8a", "armeabi-v7a", "x86", "x86_64"]);
  const selectedAbi = `${abi.stdout}${abi.stderr}`
    .trim()
    .split(",")
    .map((value) => value.trim())
    .find((value) => supported.has(value));
  if (!selectedAbi) throw new Error("Unsupported Android ABI");
  return selectedAbi as AndroidTargetArchitecture;
};

const discoverAndroid = async (
  projectRoot: string,
  runOptions: unknown,
  mode: ToolchainMode,
  runner: ToolchainCommandRunner,
  env: NodeJS.ProcessEnv,
  hostArch: HostArchitecture,
  fileSystem: ToolchainFileSystem,
  moduleResolver: ToolchainModuleResolver
): Promise<AndroidToolchainSnapshot> => {
  const wrapper = readWrapperProperties(projectRoot, mode, fileSystem);
  const androidPackages = discoverInstalledAndroidPackages(
    projectRoot,
    env,
    fileSystem,
    moduleResolver
  );
  const javaExecutable = env.JAVA_HOME
    ? path.join(env.JAVA_HOME, "bin", "java")
    : "java";
  const [java, targetArchitecture] = await Promise.all([
    command(
      runner,
      javaExecutable,
      ["-XshowSettings:properties", "-version"],
      projectRoot,
      env
    ),
    resolveAndroidTarget(projectRoot, runOptions, runner, env),
  ]);
  const properties = parseJavaProperties(`${java.stdout}\n${java.stderr}`);
  const javaSpecificationVersion = boundedToken(
    properties.get("java.specification.version") ?? "",
    /^[0-9][0-9.]*$/
  );
  const javaRuntimeVersion = boundedToken(
    properties.get("java.runtime.version") ?? "",
    /^[0-9A-Za-z.+_()-]+$/
  );
  const vendor = properties.get("java.vendor") ?? "";
  const jvmArchitecture = properties.get("os.arch") ?? "";
  const vmName = properties.get("java.vm.name") ?? "";
  const jvmArch = normalizeArchitecture(jvmArchitecture);
  if (
    !javaSpecificationVersion ||
    !vendor ||
    !jvmArch ||
    (mode === "strict" && (!javaRuntimeVersion || !vmName))
  ) {
    throw new Error("Malformed Java properties");
  }
  return {
    platform: "android",
    hostArch,
    ...androidPackages,
    javaSpecificationVersion,
    javaVendorFamily: javaVendorFamily(vendor),
    jvmArch,
    gradleVersion: wrapper.gradleVersion,
    targetArchitecture,
    ...(mode === "strict"
      ? {
          javaRuntimeVersion: javaRuntimeVersion!,
          vmFamily: javaVmFamily(vmName),
          gradleDistributionBasename: wrapper.distributionBasename,
          ...(wrapper.checksum
            ? { gradleDistributionSha256: wrapper.checksum }
            : {}),
        }
      : {}),
  };
};

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
