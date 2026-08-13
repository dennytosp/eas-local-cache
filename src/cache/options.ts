export type CacheProviderOptions = {
  maxSize?: string | number | null;
  maxEntries?: number | null;
  retentionDays?: number | null;
  autoPrune?: boolean;
};

export type NormalizedCachePolicy = {
  maxSizeBytes: number | null;
  maxEntries: number | null;
  retentionMs: number | null;
  autoPrune: boolean;
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
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new Error("Cache provider options must be an object");
  }
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
