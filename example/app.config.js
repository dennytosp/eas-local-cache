const staticConfig = require("./app.json");

module.exports = () => {
  const config = staticConfig.expo;
  const testSalt = process.env.EAS_LOCAL_CACHE_TEST_SALT;
  const environmentKey = process.env.EAS_LOCAL_CACHE_TEST_ENVIRONMENT_KEY;
  const toolchain = process.env.EAS_LOCAL_CACHE_TEST_TOOLCHAIN;
  const compression = process.env.EAS_LOCAL_CACHE_TEST_COMPRESSION;
  const lan = process.env.EAS_LOCAL_CACHE_TEST_LAN;

  if (!testSalt && !environmentKey && !toolchain && !compression && !lan) {
    return config;
  }

  return {
    ...config,
    ...(environmentKey || toolchain || compression || lan
      ? {
          buildCacheProvider: {
            ...config.buildCacheProvider,
            options: {
              ...config.buildCacheProvider.options,
              ...(environmentKey ? { environmentKey } : {}),
              ...(toolchain ? { toolchain } : {}),
              ...(compression ? { compression } : {}),
              ...(lan ? { lan } : {}),
            },
          },
        }
      : {}),
    extra: {
      ...config.extra,
      ...(testSalt ? { easLocalCacheTestSalt: testSalt } : {}),
    },
  };
};
