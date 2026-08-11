# EAS Local Cache

[![CI](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/eas-local-cache.svg)](https://www.npmjs.com/package/eas-local-cache)
[![npm downloads](https://img.shields.io/npm/dm/eas-local-cache.svg)](https://www.npmjs.com/package/eas-local-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

## Introduction

EAS Local Cache is a library designed to optimize build times by caching build artifacts locally. This allows subsequent builds with the same configuration to reuse previously built artifacts instead of rebuilding them from scratch.

## Installation

To install EAS Local Cache, select your preferred package manager:

### npm

```bash
npm install --save-dev eas-local-cache
```

### bun

```bash
bun add eas-local-cache -D
```

Add the following configuration to your `app.config.ts`:

```typescript
experiments: {
  typedRoutes: true,
  buildCacheProvider: {
    plugin: 'eas-local-cache',
  },
}
```

## How It Works

EAS Local Cache implements two main functions:

1. **Resolving Build Cache**: Checks if a build with the same fingerprint already exists in the cache.
2. **Uploading Build Cache**: Stores successful builds in the cache for future use.

The system generates a unique fingerprint hash for each build configuration. If the exact same configuration is built again, the cached version will be used, significantly reducing build times.

## Features

- **Cross-Platform Support**: Works with both iOS and Android builds.
- **Intelligent File Handling**: Properly handles both directory structures (iOS .app bundles) and single files (Android .apk).
- **Reliable Copying**: Uses platform-specific copy mechanisms for maximum reliability.

## Cache Storage

Build artifacts are stored in the `.expo/cache` directory at the project root.

Files are named according to the pattern:

- iOS: `ios_[fingerprintHash].app`
- Android: `android_[fingerprintHash].apk`

## Usage

EAS Local Cache is automatically used by Expo when building your application. No additional configuration is required.

To clear the cache manually, you can delete the `.expo/cache` directory in your project root:

```bash
rm -rf .expo/cache
```

## Troubleshooting

If you're experiencing issues with cached builds:

1. Check file permissions in the cache directory.
2. Verify that the cache directory has sufficient disk space.
3. Clear the cache directory and try again.

## Contributing

Contributions are welcome — bug reports, docs fixes, and cache-correctness fixes
especially.

```bash
git clone https://github.com/dennytosp/eas-local-cache.git
cd eas-local-cache
bun install

bun run typecheck   # tsc --noEmit over src/ and test/
bun test            # integration tests against a temporary project root
bun run build       # tsc -> build/
```

These three commands are exactly what CI runs on every pull request, on both
Ubuntu and macOS. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide
(including how to link the plugin into a real Expo app), and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community expectations.

- Found a bug? [Open an issue](https://github.com/dennytosp/eas-local-cache/issues/new?template=bug_report.yml)
- Have a usage question? [Start a discussion](https://github.com/dennytosp/eas-local-cache/discussions)
- Found a security problem? See [SECURITY.md](./SECURITY.md) — please do not open a public issue

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE) © Phong Dinh
