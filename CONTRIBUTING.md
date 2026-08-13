# Contributing to eas-local-cache

Thanks for helping improve the plugin. By participating you agree to the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## What this project is

`eas-local-cache` implements Expo's `BuildCacheProviderPlugin` interface for
local `npx expo run:ios` and `npx expo run:android` builds. Expo supplies the
project root, platform, native-input fingerprint, and successful build path.
The provider resolves or publishes a verified artifact below the project's
`.expo/cache` directory.

It is not invoked by `eas build`, including `eas build --local`. Fingerprints
are calculated by Expo; this package currently uses the supplied fingerprint as
part of its storage identity.

## Prerequisites

- Bun 1.1 or newer
- Node.js 18 or newer
- macOS and Xcode for real iOS Simulator tests
- Android SDK and an emulator for real Android tests

## Local setup

```bash
git clone https://github.com/dennytosp/eas-local-cache.git
cd eas-local-cache
bun install
bun install --cwd example
```

Read [AGENTS.md](./AGENTS.md) and the focused rules under `.agents/rules/`
before changing cache behavior or the example app.

## Validation

Run the complete static and filesystem-backed suite:

```bash
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run example:check
```

The provider tests use temporary project roots and real filesystem operations.
They cover Android files, iOS app directories, manifests, integrity failures,
quarantine, locks, concurrent writers, legacy entries, and project isolation.

## Real native round trip

The `example/` Expo Router app uses HeroUI Native and Uniwind and declares this
checkout as `"eas-local-cache": "file:.."`. Build the provider before running
the app:

```bash
bun run build
cd example
bun run verify:provider
```

Choose one platform and run the same native target twice:

```bash
bun run ios
bun run ios
```

or, with an Android emulator running:

```bash
bun run android
bun run android
```

The first run should log a cache miss and successful publication. The unchanged
second run should log a cache hit and Expo's custom binary path. iOS physical
devices do not participate in Expo build-cache providers.

## Pull requests

1. Branch from `main` and keep the change focused.
2. Add tests for every cache-format, recovery, concurrency, or keying change.
3. Exercise the example app when native behavior changes.
4. Add an entry to [CHANGELOG.md](./CHANGELOG.md) under `Unreleased`.
5. Use an English conventional commit subject and complete the PR template.

## Cache correctness

- A false cache miss costs build time; a false hit can run the wrong native app.
  Prefer correctness.
- Derive all paths from Expo's `projectRoot`, never the current working
  directory.
- Never publish partial data. Stage, validate, and atomically rename entries.
- Treat cache contents as untrusted and fail open to a normal Expo build.
- Keep runtime dependencies minimal; Node's standard library is preferred.
- Never delete outside the library-owned subtree of `.expo/cache`.

## Releasing

Source pull requests normally leave the package version unchanged. Release
automation uses the `release:patch`, `release:minor`, or `release:major` label,
or an explicit stable version increase. See [RELEASING.md](./RELEASING.md) for
the complete process.

For usage questions, start a GitHub Discussion. Use issues for reproducible
bugs and feature proposals.
