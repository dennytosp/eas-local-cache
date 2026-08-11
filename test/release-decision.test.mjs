import { describe, expect, test } from "bun:test";

import {
  classifyRelease,
  highestRelease,
} from "../scripts/collect-release-decision.mjs";

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
