const staticConfig = require("./app.json");

module.exports = () => {
  const config = staticConfig.expo;
  const testSalt = process.env.EAS_LOCAL_CACHE_TEST_SALT;
  const environmentKey = process.env.EAS_LOCAL_CACHE_TEST_ENVIRONMENT_KEY;
  const compression = process.env.EAS_LOCAL_CACHE_TEST_COMPRESSION;

  if (!testSalt && !environmentKey && !compression) {
    return config;
  }

  return {
    ...config,
    ...(environmentKey || compression
      ? {
          buildCacheProvider: {
            ...config.buildCacheProvider,
            options: {
              ...config.buildCacheProvider.options,
              ...(environmentKey ? { environmentKey } : {}),
              ...(compression ? { compression } : {}),
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
