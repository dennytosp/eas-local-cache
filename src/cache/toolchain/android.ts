import * as path from "path";

import {
  discoverInstalledAndroidPackages,
  javaVendorFamily,
  javaVmFamily,
  parseJavaProperties,
  readWrapperProperties,
} from "./android-config";
import { resolveAndroidTarget } from "./android-target";
import { boundedToken, command, normalizeArchitecture } from "./runtime";
import type {
  AndroidToolchainSnapshot,
  HostArchitecture,
  ToolchainCommandRunner,
  ToolchainFileSystem,
  ToolchainMode,
  ToolchainModuleResolver,
} from "./types";

export const discoverAndroid = async (
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
