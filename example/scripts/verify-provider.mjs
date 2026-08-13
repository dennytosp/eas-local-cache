import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const readJson = (relativePath) =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

const appConfig = readJson("../app.json");
const packageJson = readJson("../package.json");
const providerPackageJson = readJson("../../package.json");
const providerModule = require("eas-local-cache");
const provider = providerModule.default ?? providerModule;

const expectedDependency = "file:..";
const configuredDependency = packageJson.devDependencies?.["eas-local-cache"];

if (configuredDependency !== expectedDependency) {
  throw new Error(
    `Expected eas-local-cache devDependency to be ${expectedDependency}, received ${String(
      configuredDependency
    )}`
  );
}

const configuredPlugin = appConfig.expo.buildCacheProvider?.plugin;

if (configuredPlugin !== "eas-local-cache") {
  throw new Error(
    `Expected expo.buildCacheProvider.plugin to be eas-local-cache, received ${String(
      configuredPlugin
    )}`
  );
}

for (const method of ["calculateFingerprintHash", "resolveBuildCache", "uploadBuildCache"]) {
  if (typeof provider?.[method] !== "function") {
    throw new TypeError(`The local provider does not export ${method}()`);
  }
}

const evaluateConfig = (salt) => {
  const output = execFileSync(
    process.execPath,
    ["./node_modules/expo/bin/cli", "config", "--type", "public", "--json"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        ...(salt ? { EAS_LOCAL_CACHE_TEST_SALT: salt } : {}),
      },
    }
  );
  return JSON.parse(output);
};

const configWithoutSalt = evaluateConfig(null);
const configWithSalt = evaluateConfig("non-secret-provider-verification");
if (configWithoutSalt.extra?.easLocalCacheTestSalt !== undefined) {
  throw new Error("The cache test salt must be omitted unless explicitly set");
}
if (configWithSalt.extra?.easLocalCacheTestSalt !== "non-secret-provider-verification") {
  throw new Error("Dynamic Expo config did not expose the cache test salt");
}

if (providerPackageJson.bin?.["eas-local-cache"] !== "build/cli-bin.js") {
  throw new Error("The local package does not expose the Cache Inspector CLI");
}

const configuredOptions = appConfig.expo.buildCacheProvider?.options;
if (
  configuredOptions?.maxSize !== "20GB" ||
  configuredOptions?.maxEntries !== 50 ||
  configuredOptions?.retentionDays !== 14 ||
  configuredOptions?.autoPrune !== true
) {
  throw new Error("The example cleanup policy does not match the documented defaults");
}

console.log("Verified local eas-local-cache provider integration.");
