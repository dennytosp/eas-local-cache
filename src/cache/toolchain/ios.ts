import { boundedToken, command } from "./runtime";
import type {
  HostArchitecture,
  IosToolchainSnapshot,
  ToolchainCommandRunner,
  ToolchainMode,
} from "./types";

export const discoverIos = async (
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
