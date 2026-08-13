import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ARTIFACT_MTIME_METHOD,
  elapsedMilliseconds,
  estimateArtifactReadyDuration,
  estimateTimeSaved,
} from "../src/cache/timing";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-timing-"))
);

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
});

const setMtime = (candidate: string, timestampMs: number): void => {
  const date = new Date(timestampMs);
  fs.utimesSync(candidate, date, date);
};

describe("artifact timing", () => {
  it("uses an APK mtime only inside the safe build window", () => {
    const artifactPath = path.join(root, "artifact.apk");
    fs.writeFileSync(artifactPath, "apk");
    setMtime(artifactPath, 15_000);

    expect(
      estimateArtifactReadyDuration({
        artifactPath,
        platform: "android",
        missStartedAtMs: 10_000,
        uploadObservedAtMs: 20_000,
      })
    ).toEqual({ durationMs: 5_000, method: ARTIFACT_MTIME_METHOD });

    setMtime(artifactPath, 9_999);
    expect(
      estimateArtifactReadyDuration({
        artifactPath,
        platform: "android",
        missStartedAtMs: 10_000,
        uploadObservedAtMs: 20_000,
      })
    ).toBeNull();

    setMtime(artifactPath, 22_001);
    expect(
      estimateArtifactReadyDuration({
        artifactPath,
        platform: "android",
        missStartedAtMs: 10_000,
        uploadObservedAtMs: 20_000,
      })
    ).toBeNull();
  });

  it("uses the newest regular file in an app without following symlinks", () => {
    const artifactPath = path.join(root, "artifact.app");
    fs.mkdirSync(path.join(artifactPath, "Frameworks"), { recursive: true });
    const binary = path.join(artifactPath, "App");
    const framework = path.join(artifactPath, "Frameworks", "Library");
    fs.writeFileSync(binary, "binary");
    fs.writeFileSync(framework, "framework");
    setMtime(binary, 12_000);
    setMtime(framework, 14_000);
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "outside");
    setMtime(outside, 99_000);
    fs.symlinkSync(outside, path.join(artifactPath, "unsafe-link"));

    expect(
      estimateArtifactReadyDuration({
        artifactPath,
        platform: "ios",
        missStartedAtMs: 10_000,
        uploadObservedAtMs: 20_000,
      })
    ).toEqual({ durationMs: 4_000, method: ARTIFACT_MTIME_METHOD });
  });

  it("rejects unsafe artifact types, empty apps, and durations above six hours", () => {
    const emptyApp = path.join(root, "empty.app");
    fs.mkdirSync(emptyApp);
    expect(
      estimateArtifactReadyDuration({
        artifactPath: emptyApp,
        platform: "ios",
        missStartedAtMs: 0,
        uploadObservedAtMs: 1_000,
      })
    ).toBeNull();

    const target = path.join(root, "target.apk");
    const link = path.join(root, "link.apk");
    fs.writeFileSync(target, "apk");
    fs.symlinkSync(target, link);
    expect(
      estimateArtifactReadyDuration({
        artifactPath: link,
        platform: "android",
        missStartedAtMs: 0,
        uploadObservedAtMs: 1_000,
      })
    ).toBeNull();

    setMtime(target, 6 * 60 * 60 * 1000 + 1);
    expect(
      estimateArtifactReadyDuration({
        artifactPath: target,
        platform: "android",
        missStartedAtMs: 0,
        uploadObservedAtMs: 7 * 60 * 60 * 1000,
      })
    ).toBeNull();
  });

  it("measures lookup time monotonically and never invents savings", () => {
    expect(elapsedMilliseconds(1_000_000n, 4_500_000n)).toBe(3.5);
    expect(elapsedMilliseconds(4n, 3n)).toBe(0);
    expect(estimateTimeSaved(1_000, 25)).toBe(975);
    expect(estimateTimeSaved(10, 20)).toBe(0);
    expect(estimateTimeSaved(undefined, 20)).toBeUndefined();
    expect(estimateTimeSaved(Number.NaN, 20)).toBeUndefined();
  });
});
