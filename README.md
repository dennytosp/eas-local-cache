# EAS Local Cache

[![CI](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/eas-local-cache.svg)](https://www.npmjs.com/package/eas-local-cache)
[![npm downloads](https://img.shields.io/npm/dm/eas-local-cache.svg)](https://www.npmjs.com/package/eas-local-cache)
[![TypeScript](https://img.shields.io/badge/types-included-blue.svg)](./src/index.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

A lightweight build cache provider that makes repeated local Expo builds fast.
When the project fingerprint has not changed, Expo reuses the cached native app
instead of compiling it again.

- **Fast local rebuilds** with fingerprint-based cache hits
- **iOS and Android support** for `.app` bundles and `.apk` files
- **Fully local storage** with no upload, account, or external service
- **Project-scoped caching** that works from subdirectories and monorepos
- **Atomic and self-healing entries** that reject partial or corrupted builds
- **Automatic storage limits** with TTL and least-recently-used cleanup
- **Cache Inspector CLI** for capacity, entry, health, and prune operations
- **Explainable cache misses** based on privacy-safe Expo fingerprint evidence
- **Local hit-rate telemetry** with conservative estimated time saved
- **Typed TypeScript implementation** with no runtime changes to your app

---

https://github.com/user-attachments/assets/bc7c09ad-333e-4043-a52c-667c3919668d

---

## Requirements

- Node.js 18 or newer
- An Expo project with a version of Expo CLI that supports
  `buildCacheProvider`
- Xcode for iOS Simulator builds or the Android SDK for Android builds

This package only participates in local native builds. It is not imported by
your application at runtime.

## Installation

Choose your preferred package manager:

```bash
# npm
npm install --save-dev eas-local-cache

# yarn
yarn add --dev eas-local-cache

# pnpm
pnpm add --save-dev eas-local-cache

# bun
bun add --dev eas-local-cache
```

## Quick Start

Add the provider to your `app.config.ts`:

```typescript
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  buildCacheProvider: {
    plugin: "eas-local-cache",
    options: {
      maxSize: "20GB",
      maxEntries: 50,
      retentionDays: 14,
      autoPrune: true,
    },
  },
});
```

Or use `app.json`:

```json
{
  "expo": {
    "buildCacheProvider": {
      "plugin": "eas-local-cache",
      "options": {
        "maxSize": "20GB",
        "maxEntries": 50,
        "retentionDays": 14,
        "autoPrune": true
      }
    }
  }
}
```

> [!IMPORTANT]
> Use the top-level `buildCacheProvider` field. The older
> `experiments.buildCacheProvider` field is deprecated in current Expo
> releases.

Run your app as usual:

```bash
npx expo run:ios
# or
npx expo run:android
```

The first run compiles the native app and stores its artifact. A later run with
the same project fingerprint restores that artifact and launches it without
recompiling.

The options shown above are also the zero-config defaults. Sizes use binary
multipliers, so `20GB` means 20 GiB. Set an individual limit to `null` to
disable it, or set `autoPrune` to `false` to keep maintenance manual.

## How It Works

1. Expo calculates a fingerprint from the native build inputs.
2. `eas-local-cache` derives a safe cache identity from the platform and
   fingerprint, then validates the matching entry in `<projectRoot>/.expo/cache`.
3. On a cache hit, Expo installs and launches the stored artifact.
4. On a cache miss, Expo builds normally. The successful artifact is copied to
   a staging entry, checksummed, and atomically published for the next run.

Concurrent builds for the same fingerprint coordinate through a per-entry lock.
Incomplete staging data is never used, and a versioned entry that fails its
manifest or integrity checks is moved to quarantine and treated as a cache miss.

The provider retains only bounded, sanitized fingerprint descriptors beside new
entries. On an ordinary miss it compares those descriptors and reports up to
three evidence groups, such as Expo config or native dependency changes. Raw
Expo config, source contents, absolute paths, device IDs, and arbitrary reason
strings are never written to diagnostic metadata.

After a successful upload, automatic maintenance removes expired data first and
then least-recently-used entries until the size and entry-count soft caps are
satisfied. The new artifact, recently returned artifacts, and active builds are
protected. Maintenance failure never turns a successful native build into an
error. The size cap covers valid and invalid entries, staging, quarantine, and
trash. Operational metadata and backward-compatible legacy entries are reported
by `stats` but are not deleted automatically.

## Cache Inspector CLI

Run the inspector from the Expo project root:

```bash
npx eas-local-cache stats
npx eas-local-cache list
npx eas-local-cache doctor
npx eas-local-cache prune --dry-run
npx eas-local-cache prune --max-size 10GB --max-entries 20 --retention-days 7
```

Every command accepts `--project-root <path>` and `--json` for automation.
`doctor` performs the same full identity and integrity checks used by cache
resolution without changing the cache. `prune --dry-run` uses the same planner
as real and automatic cleanup. Stats report exact bytes and counts plus hit rate
for retained local decisions. Estimated time saved uses a conservative
native-artifact timestamp sample; a hit without reliable timing remains
explicitly unknown. Telemetry is retained for 90 days and at most 10,000
events, independent of `autoPrune`.

The cache is resolved from the project root supplied by Expo, not the current
working directory. This keeps caches isolated when commands are run from a
subdirectory, monorepo root, or with a custom project root.

## Cache Storage

Versioned artifacts are stored under `.expo/cache/eas-local-cache/v1`:

| Path          | Purpose                                       |
| ------------- | --------------------------------------------- |
| `entries/`    | Immutable platform artifacts and manifests    |
| `staging/`    | Incomplete uploads, never used for cache hits |
| `locks/`      | Per-entry writer coordination                 |
| `quarantine/` | Invalid entries retained for diagnosis        |
| `access/`     | Atomic last-used records and short leases     |
| `events/`     | Bounded, private resolve telemetry            |
| `state/`      | Last valid cleanup policy                     |
| `trash/`      | Atomic removal tombstones                     |

Each entry contains `artifact.app` or `artifact.apk` plus `manifest.json` and,
for new builds, optional privacy-safe `insight.json`. The directory name is a
SHA-256 cache identity, so fingerprint values never become raw filesystem
paths. Flat `ios_<fingerprint>.app` and
`android_<fingerprint>.apk` entries created by earlier releases remain readable
for backward compatibility but are reported as unverified legacy entries.

The directory is local to each project and should not be committed to source
control.

## Limitations

- The provider is used only by local `npx expo run:ios` and
  `npx expo run:android` commands.
- `eas build`, including `eas build --local`, does not invoke this provider.
- Expo skips build cache providers for physical iOS device builds. Only iOS
  Simulator builds participate in caching.
- Cache artifacts stay on the current machine; this package does not share them
  with teammates or CI runners.

## Troubleshooting

### The build never hits the cache

- Confirm `buildCacheProvider` is not nested under `experiments`.
- Check that `.expo/cache` exists in the Expo project root.
- Make sure the native build inputs have not changed. A changed fingerprint is
  expected to produce a cache miss.
- Look for `Cache hit`, `Cache miss`, and `Possible cause` in Expo CLI output.

### Clear the local cache

Delete only this provider's project cache and run the build again:

```bash
rm -rf .expo/cache/eas-local-cache
```

### A cached artifact is invalid

Versioned artifacts are verified before every cache hit. Invalid entries are
quarantined automatically and Expo continues with a normal rebuild. If the
problem repeats, clear `.expo/cache` and check that the project directory is
writable and has enough available disk space.

## Example App

The [`example`](./example) Expo app uses HeroUI Native and Uniwind and links the
current checkout through a local package dependency. It is the end-to-end
fixture for verifying a real miss, upload, and subsequent hit:

```bash
bun run build
bun install --cwd example
bun run --cwd example ios
bun run --cwd example ios
# explained A miss → A hit → B config miss → B hit
bun run --cwd example cache:test:ios
# build-only iOS oracle (no Simulator launch required)
EAS_LOCAL_CACHE_TEST_DEVICE=generic bun run --cwd example cache:test:ios
```

Use an iOS Simulator, or replace `ios` with `android` after starting an
Android emulator. Run `bun run example:check` for the static integration checks.

## Contributing

Bug reports, documentation fixes, and cache-correctness improvements are
welcome.

```bash
git clone https://github.com/dennytosp/eas-local-cache.git
cd eas-local-cache
bun install

bun run typecheck
bun test
bun run build
```

These are the core validation commands. CI also checks formatting, lint rules,
the release version, and the published package contents on Ubuntu and macOS.
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community expectations.

- Found a bug? [Open an issue](https://github.com/dennytosp/eas-local-cache/issues/new?template=bug_report.yml)
- Have a usage question? [Start a discussion](https://github.com/dennytosp/eas-local-cache/discussions)
- Found a security issue? Read [SECURITY.md](./SECURITY.md) and please do not
  open a public issue

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE) © Phong Dinh
