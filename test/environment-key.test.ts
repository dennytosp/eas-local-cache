import { describe, expect, it } from "bun:test";

import {
  ENVIRONMENT_FINGERPRINT_PREFIX,
  createEffectiveEnvironmentIdentity,
  serializeEnvironmentKeyPayload,
  type EnvironmentIdentityInput,
  type ToolchainSnapshot,
} from "../src/cache/environment-key";
import { normalizeEnvironmentOptions } from "../src/cache/options";

const makeInput = (
  overrides: Partial<EnvironmentIdentityInput> = {}
): EnvironmentIdentityInput => ({
  baseFingerprintHash: "expo-base-hash",
  platform: "ios",
  runProfile: { configuration: "Debug", scheme: "Example" },
  toolchainMode: "safe",
  toolchain: {
    hostArchitecture: "arm64",
    xcodeBuildVersion: "16F6",
    simulatorSdkBuildVersion: "22F76",
  },
  environmentKeyDigest: null,
  ...overrides,
});

describe("effective environment identity", () => {
  it("preserves Expo hash parity only for off mode without a manual key", () => {
    const identity = createEffectiveEnvironmentIdentity(
      makeInput({
        toolchainMode: "off",
        toolchain: {},
      })
    );

    expect(identity).toEqual({
      baseFingerprintHash: "expo-base-hash",
      effectiveFingerprintHash: "expo-base-hash",
      keySchema: "expo-base",
      toolchainMode: "off",
      environmentKeyDigest: null,
    });
  });

  it("canonicalizes nested objects independently of construction order", () => {
    const leftToolchain: ToolchainSnapshot = {
      xcode: { marketingVersion: "16.4", buildVersion: "16F6" },
      hostArchitecture: "arm64",
    };
    const rightToolchain: ToolchainSnapshot = {
      hostArchitecture: "arm64",
      xcode: { buildVersion: "16F6", marketingVersion: "16.4" },
    };
    const left = makeInput({ toolchain: leftToolchain });
    const right = makeInput({ toolchain: rightToolchain });

    expect(serializeEnvironmentKeyPayload(left)).toBe(
      serializeEnvironmentKeyPayload(right)
    );
    expect(createEffectiveEnvironmentIdentity(left)).toEqual(
      createEffectiveEnvironmentIdentity(right)
    );
  });

  it("separates every safe identity component", () => {
    const baseline = createEffectiveEnvironmentIdentity(makeInput());
    const changes: EnvironmentIdentityInput[] = [
      makeInput({ baseFingerprintHash: "another-expo-hash" }),
      makeInput({ platform: "android" }),
      makeInput({
        runProfile: { configuration: "Release", scheme: "Example" },
      }),
      makeInput({ toolchainMode: "strict" }),
      makeInput({
        toolchain: {
          hostArchitecture: "x64",
          xcodeBuildVersion: "16F6",
          simulatorSdkBuildVersion: "22F76",
        },
      }),
    ];

    expect(baseline.keySchema).toBe("environment-v1");
    expect(baseline.effectiveFingerprintHash).toMatch(
      /^elc-env-v1:[a-f0-9]{64}$/
    );
    for (const input of changes) {
      expect(
        createEffectiveEnvironmentIdentity(input).effectiveFingerprintHash
      ).not.toBe(baseline.effectiveFingerprintHash);
    }
  });

  it("uses only the base hash and digest when off mode has a manual key", () => {
    const normalized = normalizeEnvironmentOptions({
      toolchain: "off",
      environmentKey: "never-persist-this-key",
    });
    const first = makeInput({
      ...normalized,
      toolchain: { ignored: "first" },
    });
    const second = makeInput({
      ...normalized,
      platform: "android",
      runProfile: { variant: "release", allArch: true },
      toolchain: { ignored: "second" },
    });
    const firstIdentity = createEffectiveEnvironmentIdentity(first);
    const serialized = serializeEnvironmentKeyPayload(first);

    expect(firstIdentity.effectiveFingerprintHash).toBe(
      createEffectiveEnvironmentIdentity(second).effectiveFingerprintHash
    );
    expect(
      firstIdentity.effectiveFingerprintHash.startsWith(
        ENVIRONMENT_FINGERPRINT_PREFIX
      )
    ).toBe(true);
    expect(serialized).not.toContain("never-persist-this-key");
    expect(JSON.stringify(firstIdentity)).not.toContain(
      "never-persist-this-key"
    );
  });

  it("separates different manual keys without exposing either raw value", () => {
    const firstOptions = normalizeEnvironmentOptions({
      environmentKey: "private-context-a",
    });
    const secondOptions = normalizeEnvironmentOptions({
      environmentKey: "private-context-b",
    });
    const first = createEffectiveEnvironmentIdentity(makeInput(firstOptions));
    const second = createEffectiveEnvironmentIdentity(makeInput(secondOptions));

    expect(first.effectiveFingerprintHash).not.toBe(
      second.effectiveFingerprintHash
    );
    const persistedShape = JSON.stringify({ first, second });
    expect(persistedShape).not.toContain("private-context-a");
    expect(persistedShape).not.toContain("private-context-b");
  });

  it("rejects malformed base hashes, digests, and canonical values", () => {
    expect(() =>
      createEffectiveEnvironmentIdentity(makeInput({ baseFingerprintHash: "" }))
    ).toThrow();
    expect(() =>
      createEffectiveEnvironmentIdentity(
        makeInput({ environmentKeyDigest: "not-a-sha256" })
      )
    ).toThrow();
    expect(() =>
      serializeEnvironmentKeyPayload(
        makeInput({
          toolchain: { invalid: Number.POSITIVE_INFINITY },
        })
      )
    ).toThrow();
  });
});
