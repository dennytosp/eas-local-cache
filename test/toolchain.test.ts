import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  discoverToolchain,
  type ToolchainCommandRequest,
  type ToolchainCommandRunner,
} from "../src/cache/toolchain";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const makeAndroidProject = (checksum?: string) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elc-toolchain-"));
  roots.push(projectRoot);
  const wrapperRoot = path.join(projectRoot, "android", "gradle", "wrapper");
  fs.mkdirSync(wrapperRoot, { recursive: true });
  fs.writeFileSync(
    path.join(wrapperRoot, "gradle-wrapper.properties"),
    [
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip",
      ...(checksum ? [`distributionSha256Sum=${checksum}`] : []),
    ].join("\n")
  );
  return projectRoot;
};

const fixtureRunner =
  (
    resolver: (request: ToolchainCommandRequest) => {
      stdout?: string;
      stderr?: string;
    }
  ): ToolchainCommandRunner =>
  async (request) => {
    expect(request.timeoutMs).toBe(2_000);
    expect(request.maxOutputBytes).toBe(64 * 1024);
    const result = resolver(request);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

describe("iOS toolchain discovery", () => {
  it("discovers safe signals with fixed commands and no raw selectors in the snapshot", async () => {
    const seen: Array<[string, readonly string[]]> = [];
    const runner = fixtureRunner((request) => {
      seen.push([request.command, request.args]);
      if (request.command === "xcodebuild") {
        return { stdout: "Xcode 16.4\nBuild version 16F6\n" };
      }
      return { stdout: "24F74\n" };
    });
    const result = await discoverToolchain({
      projectRoot: "/private/project",
      platform: "ios",
      runOptions: { configuration: "Debug" },
      mode: "safe",
      runner,
      hostArch: "arm64",
      env: { DEVELOPER_DIR: "/private/Xcode.app" },
    });

    expect(result).toEqual({
      status: "available",
      snapshot: {
        platform: "ios",
        hostArch: "arm64",
        xcodeBuildVersion: "16F6",
        simulatorSdkBuildVersion: "24F74",
      },
    });
    expect(seen).toEqual([
      ["xcodebuild", ["-version"]],
      ["xcrun", ["--sdk", "iphonesimulator", "--show-sdk-build-version"]],
    ]);
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("adds exact marketing and SDK versions in strict mode", async () => {
    const runner = fixtureRunner((request) => {
      if (request.command === "xcodebuild") {
        return { stdout: "Xcode 16.4\nBuild version 16F6" };
      }
      return {
        stdout: request.args.includes("--show-sdk-version") ? "18.5" : "24F74",
      };
    });
    const result = await discoverToolchain({
      projectRoot: "/project",
      platform: "ios",
      runOptions: {},
      mode: "strict",
      runner,
    });
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.snapshot).toMatchObject({
        xcodeVersion: "16.4",
        simulatorSdkVersion: "18.5",
      });
    }
  });

  it("fails closed for malformed required output", async () => {
    const result = await discoverToolchain({
      projectRoot: "/project",
      platform: "ios",
      runOptions: {},
      mode: "safe",
      runner: fixtureRunner(() => ({ stdout: "unexpected /private/path" })),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "malformed-output",
    });
  });

  it("fails closed before discovery for an unknown host architecture", async () => {
    const result = await discoverToolchain({
      projectRoot: "/project",
      platform: "ios",
      runOptions: {},
      mode: "safe",
      hostArch: "riscv64",
      runner: fixtureRunner(() => {
        throw new Error("commands must not run");
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "malformed-output",
    });
  });

  it("rejects an interactive scheme that Expo resolves after the callback", async () => {
    const result = await discoverToolchain({
      projectRoot: "/project",
      platform: "ios",
      runOptions: { scheme: true },
      mode: "safe",
      runner: fixtureRunner(() => {
        throw new Error("commands must not run");
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "invalid-run-profile",
    });
  });
});

const javaOutput = [
  "Property settings:",
  "    java.specification.version = 21",
  "    java.vendor = Eclipse Adoptium",
  "    java.runtime.version = 21.0.7+6-LTS",
  "    java.vm.name = OpenJDK 64-Bit Server VM",
  "    os.arch = aarch64",
].join("\n");

describe("Android toolchain discovery", () => {
  it("correlates an exact target and chooses the first supported ordered ABI", async () => {
    const projectRoot = makeAndroidProject();
    const commands: string[][] = [];
    const runner = fixtureRunner((request) => {
      commands.push([request.command, ...request.args]);
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      if (request.args[0] === "devices") {
        return {
          stdout:
            "List of devices attached\nSERIAL-ONE device product:sdk model:Pixel_9 device:emu\nSERIAL-TWO device model:Pixel_8\n",
        };
      }
      return { stdout: "arm64-v8a,armeabi-v7a,x86_64\n" };
    });
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: "Pixel_9" },
      mode: "safe",
      runner,
      hostArch: "x64",
      env: {
        JAVA_HOME: "/secret/jdk",
        ANDROID_SDK_ROOT: "/secret/android-sdk",
      },
    });

    expect(result).toEqual({
      status: "available",
      snapshot: {
        platform: "android",
        hostArch: "x86_64",
        javaSpecificationVersion: "21",
        javaVendorFamily: "adoptium",
        jvmArch: "arm64",
        gradleVersion: "8.13",
        targetArchitecture: "arm64-v8a",
      },
    });
    expect(commands.some((item) => item.includes("gradlew"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SERIAL-ONE");
    expect(JSON.stringify(result)).not.toContain("/secret");
  });

  it("correlates Expo's emulator selector through a unique bounded AVD name", async () => {
    const projectRoot = makeAndroidProject();
    const commands: string[][] = [];
    const runner = fixtureRunner((request) => {
      commands.push([request.command, ...request.args]);
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      if (request.args[0] === "devices") {
        return {
          stdout:
            "List of devices attached\nemulator-5554 device model:sdk_gphone64_arm64\nemulator-5556 device model:sdk_gphone64_arm64\n",
        };
      }
      if (request.args.includes("emu")) {
        return {
          stdout:
            request.args[1] === "emulator-5554"
              ? "Pixel_9_API_35\nOK\n"
              : "Pixel_8_API_34\nOK\n",
        };
      }
      return { stdout: "arm64-v8a,armeabi-v7a,x86_64\n" };
    });
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: "Pixel_9_API_35" },
      mode: "safe",
      runner,
      hostArch: "arm64",
      env: {},
    });

    expect(result).toMatchObject({
      status: "available",
      snapshot: { targetArchitecture: "arm64-v8a" },
    });
    expect(commands).toContainEqual([
      "adb",
      "-s",
      "emulator-5554",
      "emu",
      "avd",
      "name",
    ]);
    expect(commands).toContainEqual([
      "adb",
      "-s",
      "emulator-5554",
      "shell",
      "getprop",
      "ro.product.cpu.abilist",
    ]);
    expect(JSON.stringify(result)).not.toContain("Pixel_9_API_35");
    expect(JSON.stringify(result)).not.toContain("emulator-5554");
  });

  it("rejects an emulator selector shared by multiple online AVDs", async () => {
    const projectRoot = makeAndroidProject();
    const runner = fixtureRunner((request) => {
      if (request.command === "java") return { stderr: javaOutput };
      if (request.args[0] === "devices") {
        return {
          stdout:
            "List of devices attached\nemulator-5554 device model:sdk_gphone64_arm64\nemulator-5556 device model:sdk_gphone64_arm64\n",
        };
      }
      if (request.args.includes("emu")) return { stdout: "Shared_AVD\nOK\n" };
      throw new Error("ABI must not be queried for an ambiguous AVD");
    });
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: "Shared_AVD" },
      mode: "safe",
      runner,
      hostArch: "arm64",
      env: {},
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "target-ambiguous",
    });
  });

  it("adds bounded strict Java and wrapper fields without running Gradle", async () => {
    const checksum = "a".repeat(64);
    const projectRoot = makeAndroidProject(checksum);
    const runner = fixtureRunner((request) => {
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      throw new Error("ADB must not run for all-architecture builds");
    });
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { allArch: true },
      mode: "strict",
      runner,
    });
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.snapshot).toMatchObject({
        javaRuntimeVersion: "21.0.7+6-LTS",
        vmFamily: "hotspot",
        gradleDistributionBasename: "gradle-8.13-bin.zip",
        gradleDistributionSha256: checksum,
        targetArchitecture: "all",
      });
    }
  });

  it("fails closed for an unknown JVM architecture", async () => {
    const projectRoot = makeAndroidProject();
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { allArch: true },
      mode: "safe",
      hostArch: "arm64",
      runner: fixtureRunner((request) => {
        if (request.command.endsWith("java")) {
          return {
            stderr: javaOutput.replace(
              "os.arch = aarch64",
              "os.arch = riscv64"
            ),
          };
        }
        throw new Error("ADB must not run");
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "malformed-output",
    });
  });

  it("targets an ABI for flavored debug-optimized variants", async () => {
    const projectRoot = makeAndroidProject();
    const runner = fixtureRunner((request) => {
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      if (request.args[0] === "devices") {
        return { stdout: "List of devices attached\nA device model:One\n" };
      }
      return { stdout: "x86_64,x86" };
    });
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { variant: "previewDebugOptimized" },
      mode: "safe",
      runner,
    });
    expect(result).toMatchObject({
      status: "available",
      snapshot: { targetArchitecture: "x86_64" },
    });
  });

  it("rejects ambiguous devices, boolean selectors, unsupported ABIs, and offline selection", async () => {
    const projectRoot = makeAndroidProject();
    const runner = fixtureRunner((request) => {
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      if (request.args[0] === "devices") {
        return {
          stdout:
            "List of devices attached\nA device model:Same\nB device model:Same\nOFF offline model:Offline\n",
        };
      }
      return { stdout: "riscv64" };
    });
    const ambiguous = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: {},
      mode: "safe",
      runner,
    });
    expect(ambiguous).toEqual({
      status: "unavailable",
      reason: "target-ambiguous",
    });

    const booleanSelector = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: true },
      mode: "safe",
      runner,
    });
    expect(booleanSelector).toEqual({
      status: "unavailable",
      reason: "invalid-run-profile",
    });

    const unboundedSelector = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: "x".repeat(257) },
      mode: "safe",
      runner,
    });
    expect(unboundedSelector).toEqual({
      status: "unavailable",
      reason: "invalid-run-profile",
    });

    const offline = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { device: "OFF" },
      mode: "safe",
      runner,
    });
    expect(offline).toEqual({
      status: "unavailable",
      reason: "target-unavailable",
    });

    const unsupportedRunner = fixtureRunner((request) => {
      if (request.command.endsWith("java")) return { stderr: javaOutput };
      if (request.args[0] === "devices")
        return { stdout: "List of devices attached\nA device model:One\n" };
      return { stdout: "riscv64" };
    });
    const unsupported = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: {},
      mode: "safe",
      runner: unsupportedRunner,
    });
    expect(unsupported).toEqual({
      status: "unavailable",
      reason: "unsupported-abi",
    });
  });

  it("does not follow a wrapper properties symlink", async () => {
    const projectRoot = makeAndroidProject();
    const wrapper = path.join(
      projectRoot,
      "android",
      "gradle",
      "wrapper",
      "gradle-wrapper.properties"
    );
    const target = path.join(projectRoot, "outside.properties");
    fs.writeFileSync(
      target,
      "distributionUrl=https://example/gradle-9.0-bin.zip"
    );
    fs.unlinkSync(wrapper);
    fs.symlinkSync(target, wrapper);
    const result = await discoverToolchain({
      projectRoot,
      platform: "android",
      runOptions: { allArch: true },
      mode: "safe",
      runner: fixtureRunner(() => ({ stderr: javaOutput })),
    });
    expect(result.status).toBe("unavailable");
  });
});
