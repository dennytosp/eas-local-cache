import { describe, expect, test } from "bun:test";

import {
  classifyRelease,
  highestRelease,
} from "../scripts/collect-release-decision.mjs";
import {
  classifyPackageVersion,
  parseStableVersion,
} from "../scripts/check-release-version.mjs";

describe("package version policy", () => {
  test("accepts the released version", () => {
    expect(classifyPackageVersion("1.0.4", "1.0.4")).toBe("same");
  });

  test("detects a manual version bump", () => {
    expect(classifyPackageVersion("1.0.5", "1.0.4")).toBe("ahead");
    expect(classifyPackageVersion("1.1.0", "1.0.4")).toBe("ahead");
    expect(classifyPackageVersion("2.0.0", "1.0.4")).toBe("ahead");
    expect(
      classifyPackageVersion("9007199254740993.0.0", "9007199254740992.0.0")
    ).toBe("ahead");
  });

  test("rejects a version lower than the latest release", () => {
    expect(classifyPackageVersion("1.0.3", "1.0.4")).toBe("behind");
    expect(classifyPackageVersion("0.99.0", "1.0.4")).toBe("behind");
  });

  test("requires a stable semantic version", () => {
    expect(() => parseStableVersion("1.0.5-beta.1")).toThrow();
    expect(() => parseStableVersion("v1.0.5")).toThrow();
  });
});

describe("release decisions", () => {
  test("skips pull requests without a release label", () => {
    expect(classifyRelease([])).toBe("skip");
    expect(classifyRelease(["dependencies"])).toBe("skip");
  });

  test("uses the explicit release label", () => {
    expect(classifyRelease(["release:patch"])).toBe("patch");
    expect(classifyRelease(["release:minor"])).toBe("minor");
    expect(classifyRelease(["release:major"])).toBe("major");
  });

  test("uses the highest release label when labels conflict", () => {
    expect(classifyRelease(["release:patch", "release:minor"])).toBe("minor");
    expect(classifyRelease(["release:patch", "release:major"])).toBe("major");
  });

  test("keeps the highest decision across merged pull requests", () => {
    expect(highestRelease("skip", "patch")).toBe("patch");
    expect(highestRelease("patch", "minor")).toBe("minor");
    expect(highestRelease("major", "patch")).toBe("major");
  });
});
