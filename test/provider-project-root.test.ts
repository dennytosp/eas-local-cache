import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createProviderFixture } from "./fixtures/provider-fixture";

const {
  resolveBuildCache,
  uploadBuildCache,
  resolveProps,
  uploadProps,
  entryDirectory,
} = createProviderFixture();

describe("project roots", () => {
  it("uses Expo's projectRoot rather than the current directory", async () => {
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "eas-local-cache-other-"))
    );
    const buildPath = path.join(otherRoot, "Other.apk");
    fs.writeFileSync(buildPath, "other");

    try {
      const cached = await uploadBuildCache(
        uploadProps("android", "elsewhere", buildPath, otherRoot),
        {}
      );

      expect(cached).toBe(
        path.join(
          entryDirectory("android", "elsewhere", otherRoot),
          "artifact.apk"
        )
      );
      expect(fs.existsSync(cached!)).toBe(true);
      expect(fs.existsSync(entryDirectory("android", "elsewhere"))).toBe(false);
      expect(
        await resolveBuildCache(
          resolveProps("android", "elsewhere", otherRoot),
          {}
        )
      ).toBe(cached);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
