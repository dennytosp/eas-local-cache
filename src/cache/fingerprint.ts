import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

import {
  normalizeRunProfile,
  sanitizeFingerprintSources,
  type FingerprintSnapshot,
  type RawFingerprintSource,
} from "./insight";
import type { CachePlatform } from "./paths";

type ExpoFingerprint = {
  hash: string;
  sources: RawFingerprintSource[];
};

type ExpoFingerprintModule = {
  createFingerprintAsync: (
    projectRoot: string,
    options: { silent: true }
  ) => Promise<ExpoFingerprint>;
};

export type ProjectFingerprintEngine = {
  module: ExpoFingerprintModule;
  version: string;
  modulePath: string;
};

export type ProjectFingerprintCalculation = {
  fingerprintHash: string;
  snapshot: FingerprintSnapshot | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const readFingerprintPackageVersion = (packagePath: string): string => {
  const descriptor = fs.openSync(
    packagePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
  );
  let contents: string;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size > 64 * 1024) {
      throw new Error("Invalid @expo/fingerprint package metadata");
    }
    contents = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }

  const parsed: unknown = JSON.parse(contents);
  if (
    !isRecord(parsed) ||
    parsed.name !== "@expo/fingerprint" ||
    typeof parsed.version !== "string" ||
    parsed.version.length === 0 ||
    parsed.version.length > 128 ||
    hasControlCharacters(parsed.version)
  ) {
    throw new Error("Invalid @expo/fingerprint package metadata");
  }
  return parsed.version;
};

export const loadProjectFingerprintEngine = (
  projectRoot: string
): ProjectFingerprintEngine => {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const modulePath = projectRequire.resolve("@expo/fingerprint");
  const packagePath = projectRequire.resolve("@expo/fingerprint/package.json");
  const loaded: unknown = projectRequire(modulePath);

  if (
    !isRecord(loaded) ||
    typeof loaded.createFingerprintAsync !== "function"
  ) {
    throw new Error("Project @expo/fingerprint has an unsupported API");
  }

  return {
    module: loaded as ExpoFingerprintModule,
    version: readFingerprintPackageVersion(packagePath),
    modulePath,
  };
};

export const calculateProjectFingerprint = async ({
  projectRoot,
  platform,
  runOptions,
  now = () => new Date(),
}: {
  projectRoot: string;
  platform: CachePlatform;
  runOptions: unknown;
  now?: () => Date;
}): Promise<ProjectFingerprintCalculation> => {
  const engine = loadProjectFingerprintEngine(projectRoot);
  const fingerprint = await engine.module.createFingerprintAsync(projectRoot, {
    silent: true,
  });

  if (
    !isRecord(fingerprint) ||
    typeof fingerprint.hash !== "string" ||
    fingerprint.hash.length === 0 ||
    fingerprint.hash.length > 256 ||
    hasControlCharacters(fingerprint.hash) ||
    !Array.isArray(fingerprint.sources)
  ) {
    throw new Error("Project @expo/fingerprint returned malformed output");
  }

  const sources = sanitizeFingerprintSources(
    projectRoot,
    fingerprint.sources as RawFingerprintSource[]
  );
  return {
    fingerprintHash: fingerprint.hash,
    snapshot:
      sources === null
        ? null
        : {
            platform,
            fingerprintHash: fingerprint.hash,
            capturedAt: now().toISOString(),
            fingerprintEngineVersion: engine.version,
            runProfile: normalizeRunProfile(platform, runOptions),
            sources,
          },
  };
};
