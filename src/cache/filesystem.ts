import * as fs from "fs";
import * as path from "path";

export const pathExists = (candidate: string): boolean => {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export const assertManagedDirectory = (
  providerRoot: string,
  candidate: string
): void => {
  const providerStats = fs.lstatSync(providerRoot);
  const candidateStats = fs.lstatSync(candidate);
  if (
    providerStats.isSymbolicLink() ||
    !providerStats.isDirectory() ||
    candidateStats.isSymbolicLink() ||
    !candidateStats.isDirectory()
  ) {
    throw new Error("Cache-managed paths must be real directories");
  }

  const realProviderRoot = fs.realpathSync(providerRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isPathInside(realProviderRoot, realCandidate)) {
    throw new Error("Cache-managed path escapes the provider root");
  }
};

export const ensureRealDirectoryTree = (
  root: string,
  candidate: string
): void => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Cache-managed roots must be real directories");
  }

  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error("Cache-managed path escapes its trusted root");
  }

  const realRoot = fs.realpathSync(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Cache-managed paths must be real directories");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("Cache-managed paths must be real directories");
      }
    }

    if (!isPathInside(realRoot, fs.realpathSync(current))) {
      throw new Error("Cache-managed path escapes its trusted root");
    }
  }
};

export const ensureManagedDirectory = (
  providerRoot: string,
  candidate: string
): void => ensureRealDirectoryTree(providerRoot, candidate);

export const assertProviderRoot = (
  projectRoot: string,
  providerRoot: string
): void => {
  const projectStats = fs.lstatSync(projectRoot);
  const providerStats = fs.lstatSync(providerRoot);
  if (
    !projectStats.isDirectory() ||
    providerStats.isSymbolicLink() ||
    !providerStats.isDirectory()
  ) {
    throw new Error("The cache provider root must be a real directory");
  }

  if (
    !isPathInside(fs.realpathSync(projectRoot), fs.realpathSync(providerRoot))
  ) {
    throw new Error("The cache provider root escapes the project");
  }
};

export const ensureProviderRoot = (
  projectRoot: string,
  providerRoot: string
): void => {
  ensureRealDirectoryTree(projectRoot, providerRoot);
  assertProviderRoot(projectRoot, providerRoot);
};

export const calculatePathSize = (candidate: string): number => {
  const stats = fs.lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    return Buffer.byteLength(fs.readlinkSync(candidate));
  }
  if (!stats.isDirectory()) {
    return stats.isFile() ? stats.size : 0;
  }

  let total = 0;
  for (const child of fs.readdirSync(candidate)) {
    total += calculatePathSize(path.join(candidate, child));
  }
  return total;
};
