import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  calculateProjectFingerprint,
  loadProjectFingerprintEngine,
} from "../src/cache/fingerprint";
import { MAX_INSIGHT_SOURCES, normalizeRunProfile } from "../src/cache/insight";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const makeProject = (moduleSource: string, version = "9.8.7") => {
  const projectRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-fingerprint-"))
  );
  roots.push(projectRoot);
  const packageRoot = path.join(
    projectRoot,
    "node_modules",
    "@expo",
    "fingerprint"
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "fixture", private: true })
  );
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@expo/fingerprint",
      version,
      main: "index.js",
    })
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), moduleSource);
  return projectRoot;
};

describe("requested run profiles", () => {
  it("keeps only normalized iOS diagnostic fields", () => {
    expect(
      normalizeRunProfile("ios", {
        configuration: "Release",
        scheme: "Example",
        device: "SECRET-DEVICE-ID",
        port: 8081,
        appId: "com.secret.app",
      })
    ).toEqual({ configuration: "Release", scheme: "Example" });
    expect(normalizeRunProfile("ios", { scheme: true })).toEqual({
      configuration: "Debug",
      scheme: "default",
    });
  });

  it("keeps only normalized Android diagnostic fields", () => {
    expect(
      normalizeRunProfile("android", {
        variant: "release",
        allArch: true,
        device: "SECRET-DEVICE-ID",
        binary: "/secret/app.apk",
      })
    ).toEqual({ variant: "release", allArch: true });
    expect(normalizeRunProfile("android", { allArch: "yes" })).toEqual({
      variant: "debug",
      allArch: false,
    });
  });
});

describe("project-local Expo fingerprint loading", () => {
  it("returns Expo's exact hash and calls the project engine with parity options", async () => {
    const projectRoot = makeProject(`
      const fs = require("fs");
      const path = require("path");
      exports.createFingerprintAsync = async (root, options) => {
        fs.writeFileSync(path.join(root, "fingerprint-call.json"), JSON.stringify({ root, options }));
        return {
          hash: "expo-hash-exactly-as-returned",
          sources: [
            {
              type: "contents",
              id: "PRIVATE-CONTENTS-ID",
              contents: "TOKEN=do-not-persist",
              reasons: ["unknown:PRIVATE-REASON"],
              hash: "AA11"
            },
            {
              type: "file",
              filePath: "ios/Podfile",
              reasons: ["bareNativeDir"],
              hash: "BB22",
              debugInfo: { path: "/private/debug/path" }
            }
          ]
        };
      };
    `);
    fs.mkdirSync(path.join(projectRoot, "ios"));
    fs.writeFileSync(path.join(projectRoot, "ios", "Podfile"), "platform :ios");

    const engine = loadProjectFingerprintEngine(projectRoot);
    expect(engine.version).toBe("9.8.7");
    expect(engine.modulePath.startsWith(projectRoot)).toBe(true);

    const result = await calculateProjectFingerprint({
      projectRoot,
      platform: "ios",
      runOptions: { configuration: "Release", device: "SECRET-DEVICE" },
      now: () => new Date("2026-08-13T01:02:03.000Z"),
    });

    expect(result.fingerprintHash).toBe("expo-hash-exactly-as-returned");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(projectRoot, "fingerprint-call.json"), "utf8")
      )
    ).toEqual({ root: projectRoot, options: { silent: true } });
    expect(result.snapshot?.fingerprintEngineVersion).toBe("9.8.7");
    expect(result.snapshot?.sources[0]?.categories).toEqual(["other"]);
    expect(result.snapshot?.sources[1]).toMatchObject({
      displayPath: "ios/Podfile",
      digest: "bb22",
      categories: ["native-project"],
    });

    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain("TOKEN=do-not-persist");
    expect(serialized).not.toContain("PRIVATE-CONTENTS-ID");
    expect(serialized).not.toContain("PRIVATE-REASON");
    expect(serialized).not.toContain("/private/debug/path");
    expect(serialized).not.toContain(projectRoot);
    expect(serialized).not.toContain("SECRET-DEVICE");
  });

  it("keeps hash parity while omitting an over-limit snapshot", async () => {
    const projectRoot = makeProject(`
      exports.createFingerprintAsync = async () => ({
        hash: "still-valid-hash",
        sources: Array.from({ length: ${
          MAX_INSIGHT_SOURCES + 1
        } }, (_, index) => ({
          type: "contents",
          id: "source-" + index,
          contents: "secret-" + index,
          reasons: ["expoConfig"],
          hash: "aa"
        }))
      });
    `);

    const result = await calculateProjectFingerprint({
      projectRoot,
      platform: "android",
      runOptions: {},
    });

    expect(result).toEqual({
      fingerprintHash: "still-valid-hash",
      snapshot: null,
    });
  });

  it("rejects missing and malformed project-local engines", async () => {
    const missingRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-fingerprint-missing-"))
    );
    roots.push(missingRoot);
    fs.writeFileSync(path.join(missingRoot, "package.json"), "{}");
    expect(() => loadProjectFingerprintEngine(missingRoot)).toThrow();

    const malformedRoot = makeProject(
      "exports.createFingerprintAsync = async () => ({ hash: null, sources: [] });"
    );
    expect(
      calculateProjectFingerprint({
        projectRoot: malformedRoot,
        platform: "ios",
        runOptions: {},
      })
    ).rejects.toThrow("malformed output");
  });
});
