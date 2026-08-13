import * as crypto from "crypto";

import type { RunProfile } from "./insight";
import type { NormalizedEnvironmentOptions, ToolchainMode } from "./options";
import type { CachePlatform } from "./paths";

export const ENVIRONMENT_KEY_SCHEMA =
  "eas-local-cache/environment-key/v1" as const;
export const ENVIRONMENT_FINGERPRINT_PREFIX = "elc-env-v1:" as const;

export type EnvironmentKeySchema = "expo-base" | "environment-v1";

export type CanonicalEnvironmentValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalEnvironmentValue[]
  | { readonly [key: string]: CanonicalEnvironmentValue };

export type ToolchainSnapshot = {
  readonly [key: string]: CanonicalEnvironmentValue;
};

export type EnvironmentIdentityInput = NormalizedEnvironmentOptions & {
  baseFingerprintHash: string;
  platform: CachePlatform;
  runProfile: RunProfile;
  toolchain: ToolchainSnapshot;
};

export type EffectiveEnvironmentIdentity = {
  baseFingerprintHash: string;
  effectiveFingerprintHash: string;
  keySchema: EnvironmentKeySchema;
  toolchainMode: ToolchainMode;
  environmentKeyDigest: string | null;
};

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

const assertBaseFingerprintHash = (value: string): void => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacters(value)
  ) {
    throw new Error("baseFingerprintHash must be a bounded non-empty string");
  }
};

const assertEnvironmentKeyDigest = (value: string | null): void => {
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("environmentKeyDigest must be a lowercase SHA-256 digest");
  }
};

const canonicalize = (value: CanonicalEnvironmentValue): string => {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Environment identity numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Environment identity contains an unsupported value");
  }

  const object = value as Readonly<Record<string, CanonicalEnvironmentValue>>;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`);
  return `{${entries.join(",")}}`;
};

export const serializeEnvironmentKeyPayload = (
  input: EnvironmentIdentityInput
): string => {
  assertBaseFingerprintHash(input.baseFingerprintHash);
  assertEnvironmentKeyDigest(input.environmentKeyDigest);

  if (input.toolchainMode === "off") {
    return canonicalize({
      schema: ENVIRONMENT_KEY_SCHEMA,
      baseFingerprintHash: input.baseFingerprintHash,
      environmentKeyDigest: input.environmentKeyDigest,
    });
  }

  return canonicalize({
    schema: ENVIRONMENT_KEY_SCHEMA,
    baseFingerprintHash: input.baseFingerprintHash,
    platform: input.platform,
    runProfile: input.runProfile,
    toolchainMode: input.toolchainMode,
    toolchain: input.toolchain,
    environmentKeyDigest: input.environmentKeyDigest,
  });
};

export const createEffectiveEnvironmentIdentity = (
  input: EnvironmentIdentityInput
): EffectiveEnvironmentIdentity => {
  assertBaseFingerprintHash(input.baseFingerprintHash);
  assertEnvironmentKeyDigest(input.environmentKeyDigest);

  if (input.toolchainMode === "off" && input.environmentKeyDigest === null) {
    return {
      baseFingerprintHash: input.baseFingerprintHash,
      effectiveFingerprintHash: input.baseFingerprintHash,
      keySchema: "expo-base",
      toolchainMode: input.toolchainMode,
      environmentKeyDigest: null,
    };
  }

  const digest = crypto
    .createHash("sha256")
    .update(serializeEnvironmentKeyPayload(input), "utf8")
    .digest("hex");
  return {
    baseFingerprintHash: input.baseFingerprintHash,
    effectiveFingerprintHash: `${ENVIRONMENT_FINGERPRINT_PREFIX}${digest}`,
    keySchema: "environment-v1",
    toolchainMode: input.toolchainMode,
    environmentKeyDigest: input.environmentKeyDigest,
  };
};
