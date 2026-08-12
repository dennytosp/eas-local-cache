import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

import type { CachePlatform } from "./paths";

export const validateSourceArtifact = (
  source: string,
  platform: CachePlatform
) => {
  const stats = fs.lstatSync(source);

  if (stats.isSymbolicLink()) {
    throw new Error("Build artifact roots cannot be symbolic links");
  }

  if (platform === "android" && (!stats.isFile() || stats.size === 0)) {
    throw new Error("Android build artifacts must be non-empty regular files");
  }

  if (platform === "ios" && !stats.isDirectory()) {
    throw new Error("iOS build artifacts must be .app directories");
  }
};

const copyDirectory = (source: string, destination: string) => {
  if (process.platform === "darwin") {
    const result = childProcess.spawnSync("ditto", [source, destination], {
      stdio: "pipe",
    });
    if (result.status === 0) {
      return;
    }
  }

  fs.cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
};

export const copyArtifact = (
  source: string,
  destination: string,
  platform: CachePlatform
) => {
  validateSourceArtifact(source, platform);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (platform === "ios") {
    copyDirectory(source, destination);
  } else {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
};
