import plugin from "../../src/index";

const [projectRoot, fingerprintHash, serializedOptions] = process.argv.slice(2);
if (!projectRoot || !fingerprintHash || !serializedOptions) {
  throw new Error("Expected project root, fingerprint, and provider options");
}
if (!("resolveBuildCache" in plugin)) {
  throw new Error("Provider does not implement cache resolution");
}

const result = await plugin.resolveBuildCache(
  {
    projectRoot,
    platform: "android",
    fingerprintHash,
    runOptions: {},
  },
  JSON.parse(serializedOptions)
);
if (!result) {
  throw new Error("Expected a cache hit");
}
