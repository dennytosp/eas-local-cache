# EAS Local Cache

## Introduction

EAS Local Cache is a library designed to optimize build times by caching build artifacts locally. This allows subsequent builds with the same configuration to reuse previously built artifacts instead of rebuilding them from scratch.

## Installation

To install EAS Local Cache, add the following configuration to your `app.config.ts`:

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

Build artifacts are stored in the `expo/cache` directory at the project root.

Files are named according to the pattern:

- iOS: `ios_[fingerprintHash].app`
- Android: `android_[fingerprintHash].apk`

## Usage

EAS Local Cache is automatically used by Expo when building your application. No additional configuration is required.

To clear the cache manually, you can delete the `expo/cache` directory in your project root:

```bash
rm -rf expo/cache
```

## Troubleshooting

If you're experiencing issues with cached builds:

1. Check file permissions in the cache directory.
2. Verify that the cache directory has sufficient disk space.
3. Clear the cache directory and try again.

## Contributing

To contribute to this library:

1. Make changes to the implementation in `eas-local-cache`.
2. Test with various build configurations.
3. Submit pull requests with clear descriptions of changes and benefits.
