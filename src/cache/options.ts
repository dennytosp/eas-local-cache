import * as crypto from "crypto";

export const TOOLCHAIN_MODES = ["safe", "strict", "off"] as const;

export type ToolchainMode = (typeof TOOLCHAIN_MODES)[number];

export type CacheProviderOptions = {
  maxSize?: string | number | null;
  maxEntries?: number | null;
  retentionDays?: number | null;
  autoPrune?: boolean;
  toolchain?: ToolchainMode;
  environmentKey?: string;
};

export type NormalizedCachePolicy = {
  maxSizeBytes: number | null;
  maxEntries: number | null;
  retentionMs: number | null;
  autoPrune: boolean;
};

export type NormalizedEnvironmentOptions = {
  toolchainMode: ToolchainMode;
  environmentKeyDigest: string | null;
};

const GIBIBYTE = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CACHE_POLICY: Readonly<NormalizedCachePolicy> =
  Object.freeze({
    maxSizeBytes: 20 * GIBIBYTE,
    maxEntries: 50,
    retentionMs: 14 * DAY_MS,
    autoPrune: true,
  });

export const DEFAULT_ENVIRONMENT_OPTIONS: Readonly<NormalizedEnvironmentOptions> =
  Object.freeze({
    toolchainMode: "safe",
    environmentKeyDigest: null,
  });

const MAX_ENVIRONMENT_KEY_CHARACTERS = 512;

const SIZE_MULTIPLIERS = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: GIBIBYTE,
  TB: 1024 ** 4,
} as const;

const assertSafeNonNegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }

  return value;
};

const assertProviderOptions = (
  options: CacheProviderOptions
): CacheProviderOptions => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new Error("Cache provider options must be an object");
  }
  return options;
};

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

export const normalizeEnvironmentOptions = (
  options: CacheProviderOptions = {}
): NormalizedEnvironmentOptions => {
  assertProviderOptions(options);

  if (
    options.toolchain !== undefined &&
    !TOOLCHAIN_MODES.includes(options.toolchain as ToolchainMode)
  ) {
    throw new Error('toolchain must be "safe", "strict", or "off"');
  }
  if (
    options.environmentKey !== undefined &&
    typeof options.environmentKey !== "string"
  ) {
    throw new Error("environmentKey must be a string");
  }
  if (
    options.environmentKey !== undefined &&
    (Array.from(options.environmentKey).length >
      MAX_ENVIRONMENT_KEY_CHARACTERS ||
      hasControlCharacters(options.environmentKey))
  ) {
    throw new Error(
      "environmentKey must be at most 512 characters and contain no control characters"
    );
  }

  return {
    toolchainMode:
      options.toolchain ?? DEFAULT_ENVIRONMENT_OPTIONS.toolchainMode,
    environmentKeyDigest:
      options.environmentKey === undefined
        ? null
        : crypto
            .createHash("sha256")
            .update(options.environmentKey, "utf8")
            .digest("hex"),
  };
};

export const parseSizeBytes = (value: string | number): number => {
  if (typeof value === "number") {
    return assertSafeNonNegativeInteger(value, "maxSize");
  }

  const match = value
    .trim()
    .match(/^(\d+(?:\.\d+)?|\.\d+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) {
    throw new Error(
      "maxSize must be a byte count or a size ending in B, KB, MB, GB, or TB"
    );
  }

  const amountText = match[1];
  const unitText = match[2];
  if (!amountText || !unitText) {
    throw new Error("Could not parse maxSize");
  }
  const amount = Number(amountText);
  const unit = unitText.toUpperCase() as keyof typeof SIZE_MULTIPLIERS;
  return assertSafeNonNegativeInteger(
    amount * SIZE_MULTIPLIERS[unit],
    "maxSize"
  );
};

export const formatSizeBytes = (bytes: number): string => {
  assertSafeNonNegativeInteger(bytes, "bytes");

  const units = ["TB", "GB", "MB", "KB", "B"] as const;
  const unit =
    units.find((candidate) => bytes >= SIZE_MULTIPLIERS[candidate]) ?? "B";
  const value = bytes / SIZE_MULTIPLIERS[unit];
  const formatted = Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/\.?0+$/, "");

  return `${formatted}${unit}`;
};

const normalizeMaxEntries = (value: number | null | undefined) => {
  if (value === undefined) {
    return DEFAULT_CACHE_POLICY.maxEntries;
  }
  if (value === null) {
    return null;
  }
  return assertSafeNonNegativeInteger(value, "maxEntries");
};

const normalizeRetention = (value: number | null | undefined) => {
  if (value === undefined) {
    return DEFAULT_CACHE_POLICY.retentionMs;
  }
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("retentionDays must be a non-negative finite number");
  }

  return assertSafeNonNegativeInteger(value * DAY_MS, "retentionDays in ms");
};

export const normalizeCacheOptions = (
  options: CacheProviderOptions = {}
): NormalizedCachePolicy => {
  assertProviderOptions(options);
  normalizeEnvironmentOptions(options);
  if (
    options.autoPrune !== undefined &&
    typeof options.autoPrune !== "boolean"
  ) {
    throw new Error("autoPrune must be a boolean");
  }

  return {
    maxSizeBytes:
      options.maxSize === undefined
        ? DEFAULT_CACHE_POLICY.maxSizeBytes
        : options.maxSize === null
        ? null
        : parseSizeBytes(options.maxSize),
    maxEntries: normalizeMaxEntries(options.maxEntries),
    retentionMs: normalizeRetention(options.retentionDays),
    autoPrune: options.autoPrune ?? DEFAULT_CACHE_POLICY.autoPrune,
  };
};
