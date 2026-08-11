#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(version) {
  const match = STABLE_VERSION.exec(version);

  if (!match) {
    throw new Error(
      `Expected a stable semantic version (x.y.z), received: ${version}`
    );
  }

  return match.slice(1).map(BigInt);
}

export function compareStableVersions(current, released) {
  const currentParts = parseStableVersion(current);
  const releasedParts = parseStableVersion(released);

  for (let index = 0; index < currentParts.length; index += 1) {
    if (currentParts[index] > releasedParts[index]) return 1;
    if (currentParts[index] < releasedParts[index]) return -1;
  }

  return 0;
}

export function classifyPackageVersion(current, released) {
  const comparison = compareStableVersions(current, released);
  if (comparison > 0) return "ahead";
  if (comparison < 0) return "behind";
  return "same";
}

function main() {
  const released = process.env.RELEASED_VERSION;
  const outputFile = process.env.GITHUB_OUTPUT;
  const { version: current } = JSON.parse(readFileSync("package.json", "utf8"));

  if (!released) {
    throw new Error("RELEASED_VERSION is required.");
  }

  const status = classifyPackageVersion(current, released);

  if (status === "behind") {
    throw new Error(
      `package.json version ${current} is lower than released version ${released}.`
    );
  }

  if (outputFile) {
    appendFileSync(outputFile, `status=${status}\nversion=${current}\n`);
  }

  console.log(
    status === "ahead"
      ? `Manual version bump detected: ${released} -> ${current}.`
      : `Package version matches the latest release: ${current}.`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
