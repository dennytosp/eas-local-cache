import {
  EVIDENCE_CATEGORIES,
  ENVIRONMENT_EVIDENCE_CATEGORIES,
  type CacheInsight,
  type ClosestInsightResult,
  type EnvironmentDiff,
  type EnvironmentDiffItem,
  type EnvironmentEvidenceCategory,
  type EvidenceCategory,
  type InsightCandidate,
  type InsightDiff,
  type InsightDiffItem,
  type InsightIdentity,
  type InsightSource,
  type FingerprintSnapshot,
  type RunProfile,
} from "./types";
import { getInsightIdentity } from "./schema";

const sourceKey = (source: InsightSource): string =>
  `${source.type}\0${source.comparatorHash}\0${source.occurrence}`;

const primaryCategory = (
  before: InsightSource | undefined,
  after: InsightSource | undefined
): EvidenceCategory => {
  const categories = new Set([
    ...(before?.categories ?? []),
    ...(after?.categories ?? []),
  ]);
  return (
    EVIDENCE_CATEGORIES.find((category) => categories.has(category)) ?? "other"
  );
};

export const diffInsights = (
  before: Pick<CacheInsight, "sources">,
  after: Pick<CacheInsight, "sources">
): InsightDiff => {
  const beforeByKey = new Map(
    before.sources.map((source) => [sourceKey(source), source])
  );
  const afterByKey = new Map(
    after.sources.map((source) => [sourceKey(source), source])
  );
  const items: InsightDiffItem[] = [];

  for (const source of before.sources) {
    const key = sourceKey(source);
    const next = afterByKey.get(key);
    if (next === undefined) {
      items.push({
        operation: "removed",
        category: primaryCategory(source, undefined),
        before: source,
      });
    } else if (source.digest !== next.digest) {
      items.push({
        operation: "changed",
        category: primaryCategory(source, next),
        before: source,
        after: next,
      });
    }
  }

  for (const source of after.sources) {
    if (!beforeByKey.has(sourceKey(source))) {
      items.push({
        operation: "added",
        category: primaryCategory(undefined, source),
        after: source,
      });
    }
  }

  const groups = EVIDENCE_CATEGORIES.map((category) => ({
    category,
    count: items.filter((item) => item.category === category).length,
  }))
    .filter((group) => group.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        EVIDENCE_CATEGORIES.indexOf(left.category) -
          EVIDENCE_CATEGORIES.indexOf(right.category)
    );
  const added = items.filter((item) => item.operation === "added").length;
  const removed = items.filter((item) => item.operation === "removed").length;
  const changed = items.filter((item) => item.operation === "changed").length;

  return {
    items,
    added,
    removed,
    changed,
    total: added + removed + changed,
    groups,
  };
};

export const getTopEvidenceGroups = (
  diff: Pick<InsightDiff, "groups">
): InsightDiff["groups"] => diff.groups.slice(0, 3);

const environmentCategoryForField = (
  field: string
): EnvironmentEvidenceCategory => {
  if (field.startsWith("runProfile.")) return "build-profile";
  if (field === "xcodeBuildVersion" || field === "xcodeVersion") return "xcode";
  if (
    field === "simulatorSdkBuildVersion" ||
    field === "simulatorSdkVersion" ||
    field === "compileSdkVersion" ||
    field === "androidSdkPlatformRevision" ||
    field === "buildToolsVersion"
  )
    return "platform-sdk";
  if (
    field === "javaSpecificationVersion" ||
    field === "javaVendorFamily" ||
    field === "javaRuntimeVersion" ||
    field === "vmFamily"
  )
    return "jdk";
  if (field.startsWith("gradle")) return "gradle";
  if (
    field === "hostArch" ||
    field === "jvmArch" ||
    field === "targetArchitecture"
  )
    return "architecture";
  if (field === "environmentKeyDigest") return "manual-environment";
  return "key-schema";
};

const getSnapshotIdentity = (
  snapshot: FingerprintSnapshot
): InsightIdentity => ({
  fingerprintHash: snapshot.fingerprintHash,
  baseFingerprintHash: snapshot.baseFingerprintHash ?? snapshot.fingerprintHash,
  effectiveFingerprintHash:
    snapshot.effectiveFingerprintHash ?? snapshot.fingerprintHash,
  keySchema: snapshot.keySchema ?? "expo-base",
  toolchainMode: snapshot.toolchainMode ?? "off",
  toolchain: snapshot.toolchain ?? null,
  environmentKeyDigest: snapshot.environmentKeyDigest ?? null,
});

const flattenedEnvironment = (
  profile: RunProfile,
  identity: InsightIdentity
): Map<string, string | null> => {
  const fields = new Map<string, string | null>();
  for (const [key, value] of Object.entries(profile).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    fields.set(`runProfile.${key}`, String(value));
  }
  fields.set("keySchema", identity.keySchema);
  fields.set("toolchainMode", identity.toolchainMode);
  fields.set("environmentKeyDigest", identity.environmentKeyDigest);
  if (identity.toolchain !== null) {
    for (const [key, value] of Object.entries(identity.toolchain).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      if (key !== "platform") fields.set(key, value ?? null);
    }
  }
  return fields;
};

export const diffInsightEnvironment = (
  before: CacheInsight,
  after: FingerprintSnapshot
): EnvironmentDiff => {
  const beforeIdentity = getInsightIdentity(before);
  const afterIdentity = getSnapshotIdentity(after);
  let items: EnvironmentDiffItem[];

  if (before.schemaVersion === 1 && afterIdentity.keySchema !== "expo-base") {
    items = [{ field: "keySchema", category: "key-schema" }];
  } else {
    const beforeFields = flattenedEnvironment(
      before.runProfile,
      beforeIdentity
    );
    const afterFields = flattenedEnvironment(after.runProfile, afterIdentity);
    const names = [
      ...new Set([...beforeFields.keys(), ...afterFields.keys()]),
    ].sort();
    items = names
      .filter((field) => beforeFields.get(field) !== afterFields.get(field))
      .map((field) => ({
        field,
        category: environmentCategoryForField(field),
      }));
  }

  const groups = ENVIRONMENT_EVIDENCE_CATEGORIES.map((category) => ({
    category,
    count: items.filter((item) => item.category === category).length,
  })).filter((group) => group.count > 0);
  return { items, total: items.length, groups };
};

const timestampValue = (value: string | null | undefined): number => {
  const parsed =
    value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const selectClosestInsight = (
  current: FingerprintSnapshot,
  candidates: readonly InsightCandidate[]
): ClosestInsightResult => {
  if (candidates.length === 0) {
    return { status: "no-candidate", candidate: null, diff: null };
  }

  const profileCandidates = candidates.filter(
    (candidate) => candidate.insight.platform === current.platform
  );
  if (profileCandidates.length === 0) {
    return {
      status: "no-compatible-profile",
      candidate: null,
      diff: null,
    };
  }

  const engineCandidates = profileCandidates.filter(
    (candidate) =>
      candidate.insight.fingerprintEngineVersion ===
      current.fingerprintEngineVersion
  );
  if (engineCandidates.length === 0) {
    return {
      status: "fingerprint-engine-mismatch",
      candidate: null,
      diff: null,
    };
  }

  const currentIdentity = getSnapshotIdentity(current);
  const ranked = engineCandidates.map((candidate) => ({
    candidate,
    diff: diffInsights(candidate.insight, current),
    environmentDiff: diffInsightEnvironment(candidate.insight, current),
    baseFingerprintMatches:
      getInsightIdentity(candidate.insight).baseFingerprintHash ===
      currentIdentity.baseFingerprintHash,
  }));
  ranked.sort(
    (left, right) =>
      Number(right.baseFingerprintMatches) -
        Number(left.baseFingerprintMatches) ||
      left.diff.total - right.diff.total ||
      left.environmentDiff.total - right.environmentDiff.total ||
      timestampValue(right.candidate.lastAccessAt) -
        timestampValue(left.candidate.lastAccessAt) ||
      timestampValue(right.candidate.createdAt) -
        timestampValue(left.candidate.createdAt) ||
      left.candidate.entryId.localeCompare(right.candidate.entryId)
  );

  const closest = ranked[0];
  if (closest === undefined) {
    return { status: "no-candidate", candidate: null, diff: null };
  }
  return {
    status: "match",
    candidate: closest.candidate,
    diff: closest.diff,
    environmentDiff: closest.environmentDiff,
  };
};
