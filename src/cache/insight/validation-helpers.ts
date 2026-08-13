import type { CachePlatform } from "../paths";
import {
  EVIDENCE_CATEGORIES,
  MAX_PROFILE_VALUE_LENGTH,
  type EvidenceCategory,
} from "./types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

export const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean => Object.keys(value).every((key) => allowedKeys.includes(key));

export const isBoundedString = (
  value: unknown,
  maximumLength: number,
  allowEmpty = false
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  value.length <= maximumLength &&
  !hasControlCharacters(value);

export const isIsoTimestamp = (value: unknown): value is string =>
  isBoundedString(value, 64) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const isCachePlatform = (value: unknown): value is CachePlatform =>
  value === "android" || value === "ios";

export const isEvidenceCategory = (value: unknown): value is EvidenceCategory =>
  EVIDENCE_CATEGORIES.includes(value as EvidenceCategory);

export const normalizeProfileValue = (
  value: unknown,
  fallback: string
): string =>
  isBoundedString(value, MAX_PROFILE_VALUE_LENGTH) ? value : fallback;
