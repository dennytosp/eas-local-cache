const staticConfig = require("./app.json");

module.exports = () => {
  const config = staticConfig.expo;
  const testSalt = process.env.EAS_LOCAL_CACHE_TEST_SALT;
  const environmentKey = process.env.EAS_LOCAL_CACHE_TEST_ENVIRONMENT_KEY;

  if (!testSalt && !environmentKey) {
    return config;
  }

  return {
    ...config,
    ...(environmentKey
      ? {
          buildCacheProvider: {
            ...config.buildCacheProvider,
            options: {
              ...config.buildCacheProvider.options,
              environmentKey,
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
