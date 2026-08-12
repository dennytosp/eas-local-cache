# EAS Local Cache example

This Expo app is the end-to-end fixture for the package in the repository root. It uses
[HeroUI Native](https://heroui.com/docs/native) with
[Uniwind](https://docs.uniwind.dev) and loads `eas-local-cache` through a local
`file:..` development dependency.

The provider runs in Expo CLI during native builds. It is not imported by the React Native
runtime, so the terminal output—not the rendered screen—is the source of truth for cache
behavior.

## Setup

From the repository root, install and build the provider:

```bash
bun install
bun run build
```

Then install the example and verify that Expo can load the local provider:

```bash
cd example
bun install
bun run verify:provider
```

The verification checks all three integration points:

- `package.json` links `eas-local-cache` from the repository root.
- `app.json` configures `expo.buildCacheProvider` with that package.
- The built package exports `resolveBuildCache` and `uploadBuildCache`.

## Test a real cache round trip

Choose one platform and run the same command twice without changing native inputs.

### iOS Simulator

```bash
bun run ios
bun run ios
```

Expo skips build cache providers for physical iOS devices, so this test must target a
Simulator.

### Android emulator

```bash
bun run android
bun run android
```

On the first run, expect a cache miss followed by a successful upload:

```text
Cache miss for ios fingerprint ...
Cached ios build at ...
```

On the unchanged second run, expect the cached binary to be selected:

```text
Cache hit for ios fingerprint ...
Using custom binary path: ...
```

To repeat the miss-to-hit test from an empty project cache:

```bash
rm -rf .expo/cache/eas-local-cache
```

## Development checks

Run all example-level static checks and the provider-loading smoke test:

```bash
bun run check
```

Individual commands are also available:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run verify:provider
```

The `bun run ios` and `bun run android` scripts execute native Expo builds and
therefore exercise the build cache provider. Use `bun run start` when you only
need the Metro development server.
