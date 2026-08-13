const staticConfig = require("./app.json");

module.exports = () => {
  const config = staticConfig.expo;
  const testSalt = process.env.EAS_LOCAL_CACHE_TEST_SALT;

  if (!testSalt) {
    return config;
  }

  return {
    ...config,
    extra: {
      ...config.extra,
      easLocalCacheTestSalt: testSalt,
    },
  };
};
