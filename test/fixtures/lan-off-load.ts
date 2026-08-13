await import("../../src/index");

const eagerLanDependencies = Object.keys(require.cache).filter(
  (modulePath) =>
    modulePath.includes("/selfsigned/") ||
    modulePath.includes("/bonjour-service/")
);

if (eagerLanDependencies.length > 0) {
  throw new Error(
    `LAN-off provider loading eagerly imported: ${eagerLanDependencies.join(
      ", "
    )}`
  );
}
