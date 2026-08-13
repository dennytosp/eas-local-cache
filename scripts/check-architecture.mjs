import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SOURCE_LIMIT = 800;
const TEST_LIMIT = 1_000;
const ENTRYPOINT_LIMITS = new Map([
  ["src/index.ts", 450],
  ["src/cli.ts", 100],
  ["src/cli-bin.ts", 100],
]);

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(filename)
      : entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)
      ? [filename]
      : [];
  });

const relative = (filename) =>
  path.relative(ROOT, filename).split(path.sep).join("/");
const lineCount = (filename) =>
  fs.readFileSync(filename, "utf8").split(/\r?\n/).length;

const failures = [];
for (const filename of [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "test")),
]) {
  const projectPath = relative(filename);
  const limit =
    ENTRYPOINT_LIMITS.get(projectPath) ??
    (projectPath.startsWith("src/") ? SOURCE_LIMIT : TEST_LIMIT);
  const lines = lineCount(filename);
  if (lines > limit) {
    failures.push(`${projectPath}: ${lines} lines (maximum ${limit})`);
  }
}

if (failures.length > 0) {
  console.error("Architecture size limits failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nSplit the file by responsibility; do not raise a limit to bypass the check."
  );
  process.exitCode = 1;
} else {
  console.log(
    `Architecture limits passed (source <= ${SOURCE_LIMIT}, tests <= ${TEST_LIMIT}).`
  );
}
