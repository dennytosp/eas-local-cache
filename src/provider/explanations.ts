import { inventoryCache } from "../cache/catalog";
import {
  readInsight,
  selectClosestInsight,
  type EnvironmentEvidenceCategory,
  type FingerprintSnapshot,
  type InsightCandidate,
} from "../cache/insight";
import type { ResolveExplanationCode } from "../cache/events";
import type { CacheMissReason } from "../cache/store";

const environmentEvidenceLabels: Record<
  EnvironmentEvidenceCategory,
  { code: ResolveExplanationCode; label: string }
> = {
  "build-profile": {
    code: "build-profile-changed",
    label:
      "build configuration, variant, scheme, or architecture selection changed",
  },
  xcode: { code: "xcode-changed", label: "Xcode changed" },
  "platform-sdk": {
    code: "platform-sdk-changed",
    label: "the platform SDK changed",
  },
  jdk: { code: "jdk-changed", label: "the JDK changed" },
  gradle: { code: "gradle-changed", label: "Gradle changed" },
  architecture: {
    code: "architecture-changed",
    label: "the host or target architecture changed",
  },
  "manual-environment": {
    code: "manual-environment-changed",
    label: "the manual environment context changed",
  },
  "key-schema": {
    code: "environment-key-upgraded",
    label: "the cache identity upgraded to environment-aware keying",
  },
};

export const explanationForDirectReason = (
  reason: CacheMissReason
): { code: ResolveExplanationCode; message: string } => {
  switch (reason) {
    case "corrupt":
      return {
        code: "corrupt-entry",
        message: "the previous cache entry failed integrity validation",
      };
    case "lock-busy":
      return {
        code: "writer-lock-busy",
        message: "the cache entry is currently owned by another writer",
      };
    case "unsafe-legacy-path":
      return {
        code: "unsafe-legacy-path",
        message: "the legacy fingerprint path was unsafe",
      };
    case "legacy-invalid":
      return {
        code: "legacy-invalid",
        message: "the legacy artifact was incomplete or invalid",
      };
    case "compression-unavailable":
      return {
        code: "no-entry",
        message:
          "zstd is unavailable, so the compressed entry cannot be restored",
      };
    default:
      return { code: "no-entry", message: "no matching local entry exists" };
  }
};

const evidenceLabels = {
  "expo-config": {
    code: "expo-config-changed",
    label: "Expo config or config plugins changed",
  },
  "native-dependencies": {
    code: "native-dependencies-changed",
    label: "native dependencies or autolinking changed",
  },
  "native-project": {
    code: "native-project-changed",
    label: "native project inputs changed",
  },
  "project-metadata": {
    code: "project-metadata-changed",
    label: "project metadata or patches changed",
  },
  other: {
    code: "other-inputs-changed",
    label: "other native fingerprint inputs changed",
  },
} as const;

export const findInsightExplanation = (
  projectRoot: string,
  current: FingerprintSnapshot
): { code: ResolveExplanationCode; messages: string[] } => {
  try {
    const catalog = inventoryCache(projectRoot);
    const candidates: InsightCandidate[] = [];
    for (const entry of catalog.entries) {
      if (entry.platform !== current.platform) {
        continue;
      }
      try {
        const insight = readInsight(entry.directory);
        if (
          insight &&
          insight.entryId === entry.entryId &&
          insight.fingerprintHash === entry.fingerprintHash &&
          insight.platform === entry.platform
        ) {
          candidates.push({
            insight,
            entryId: entry.entryId,
            createdAt: entry.createdAt,
            lastAccessAt: entry.lastAccessedAt,
          });
        }
      } catch {
        // Doctor reports malformed optional metadata; resolution remains usable.
      }
    }

    const closest = selectClosestInsight(current, candidates);
    if (closest.status === "fingerprint-engine-mismatch") {
      return {
        code: "fingerprint-engine-mismatch",
        messages: ["the Expo fingerprint engine version changed"],
      };
    }
    if (
      closest.status !== "match" ||
      (closest.diff.total === 0 && closest.environmentDiff.total === 0)
    ) {
      return {
        code: "no-compatible-insight",
        messages: ["no compatible prior fingerprint evidence is available"],
      };
    }

    const environmentGroups = closest.environmentDiff.groups.map(
      ({ category, count }) => ({
        code: environmentEvidenceLabels[category].code,
        message: `${environmentEvidenceLabels[category].label} (${count} field${
          count === 1 ? "" : "s"
        })`,
      })
    );
    const sourceGroups = closest.diff.groups.map(({ category, count }) => ({
      code: evidenceLabels[category].code,
      message: `${evidenceLabels[category].label} (${count} source${
        count === 1 ? "" : "s"
      })`,
    }));
    const groups = [...environmentGroups, ...sourceGroups].slice(0, 3);
    const first = groups[0];
    return {
      code: first?.code ?? "no-compatible-insight",
      messages: groups.map(({ message }) => message),
    };
  } catch {
    return {
      code: "no-compatible-insight",
      messages: ["no compatible prior fingerprint evidence is available"],
    };
  }
};
