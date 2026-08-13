import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { assertManagedDirectory, ensureManagedDirectory } from "./filesystem";
import { DEFAULT_CACHE_POLICY, type NormalizedCachePolicy } from "./options";

type PolicyState = {
  schemaVersion: 1;
  updatedAt: string;
  policy: NormalizedCachePolicy;
};

const isNullableSafeInteger = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

export const readPolicyState = (
  providerRoot: string,
  stateRoot: string
): NormalizedCachePolicy => {
  try {
    assertManagedDirectory(providerRoot, stateRoot);
    const statePath = path.join(stateRoot, "policy.json");
    const descriptor = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    let contents: string;
    try {
      if (!fs.fstatSync(descriptor).isFile()) {
        throw new Error("Cache policy state must be a regular file");
      }
      contents = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    const value: unknown = JSON.parse(contents);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Malformed cache policy state");
    }
    const state = value as Partial<PolicyState>;
    const policy = state.policy;
    if (
      state.schemaVersion !== 1 ||
      typeof state.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(state.updatedAt)) ||
      typeof policy !== "object" ||
      policy === null ||
      !isNullableSafeInteger(policy.maxSizeBytes) ||
      !isNullableSafeInteger(policy.maxEntries) ||
      !isNullableSafeInteger(policy.retentionMs) ||
      typeof policy.autoPrune !== "boolean"
    ) {
      throw new Error("Malformed cache policy state fields");
    }
    return policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CACHE_POLICY };
    }
    throw error;
  }
};

export const writePolicyState = (
  providerRoot: string,
  stateRoot: string,
  policy: NormalizedCachePolicy,
  now = new Date()
): void => {
  ensureManagedDirectory(providerRoot, stateRoot);
  const state: PolicyState = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    policy,
  };
  const temporary = path.join(
    stateRoot,
    `.policy.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  const destination = path.join(stateRoot, "policy.json");
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};
