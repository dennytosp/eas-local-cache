import * as path from "path";

import { command, isBoundedSelector, isRecord } from "./runtime";
import type {
  AndroidTargetArchitecture,
  ToolchainCommandRunner,
} from "./types";

export type AdbTarget = { serial: string; state: string; name: string | null };

export const parseAdbTargets = (output: string): AdbTarget[] =>
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

export const readAvdName = async (
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

export const resolveAndroidTarget = async (
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
