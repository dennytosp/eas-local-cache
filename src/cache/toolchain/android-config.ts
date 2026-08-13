import * as fs from "fs";
import * as path from "path";

import { boundedToken } from "./runtime";
import {
  MAX_ANDROID_CONFIGURATION_BYTES,
  MAX_ANDROID_PACKAGE_PROPERTIES_BYTES,
  MAX_WRAPPER_BYTES,
  type JavaVendorFamily,
  type JavaVmFamily,
  type ToolchainFileSystem,
  type ToolchainMode,
  type ToolchainModuleResolver,
} from "./types";

export const readBoundedRegularFile = (
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

export const parsePropertyFile = (contents: string): Map<string, string> => {
  const properties = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s][^=:\s]*)\s*[=:]\s*(.*?)\s*$/);
    if (match?.[1] && match[2] !== undefined) {
      properties.set(match[1], match[2].replace(/\\:/g, ":"));
    }
  }
  return properties;
};

export const readWrapperProperties = (
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

export const optionalBoundedRegularFile = (
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

export const resolveAndroidSdkRoot = (
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

export const singleMatch = (
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

export const discoverAndroidBuildConfiguration = (
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

export const parseTomlVersions = (contents: string): Map<string, string> => {
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

export const discoverInstalledAndroidPackages = (
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

export const parseJavaProperties = (text: string) => {
  const properties = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z][a-z0-9.]+)\s*=\s*(.*?)\s*$/i);
    if (match?.[1] && match[2] !== undefined && match[2].length <= 256) {
      properties.set(match[1], match[2]);
    }
  }
  return properties;
};

export const javaVendorFamily = (value: string): JavaVendorFamily => {
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

export const javaVmFamily = (value: string): JavaVmFamily => {
  const normalized = value.toLowerCase();
  if (normalized.includes("openj9")) return "openj9";
  if (normalized.includes("graal")) return "graalvm";
  if (normalized.includes("hotspot") || normalized.includes("openjdk"))
    return "hotspot";
  return "other";
};
