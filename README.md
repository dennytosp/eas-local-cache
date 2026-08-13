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
- **Local-first storage** with no account or external service
- **Project-scoped caching** that works from subdirectories and monorepos
- **Atomic and self-healing entries** that reject partial or corrupted builds
- **Automatic storage limits** with TTL and least-recently-used cleanup
- **Opt-in zstd compression** with verified, atomic artifact restoration
- **Opt-in trusted LAN sharing** between explicitly paired team machines
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
- For optional zstd compression: a Node.js runtime with built-in zstd support,
  or the `zstd` executable available on `PATH`

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
      toolchain: "safe",
      compression: "zstd",
      lan: "off",
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
        "autoPrune": true,
        "toolchain": "safe",
        "compression": "zstd",
        "lan": "off"
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

The storage-limit and toolchain options shown above are the zero-config
defaults. Compression is deliberately opt-in: omit `compression`, or set it to
`"off"`, to keep artifacts uncompressed. Sizes use binary multipliers, so
`20GB` means 20 GiB. Set an individual limit to `null` to disable it, or set
`autoPrune` to `false` to keep maintenance manual.

`toolchain` defaults to `safe`, separating artifacts by build profile and
deterministic Xcode/Simulator SDK or JDK/Gradle/Android ABI signals. Use
`strict` for additional exact versions, or `off` only when you explicitly want
Expo's original fingerprint behavior. An optional `environmentKey` adds a
team-defined context; only its SHA-256 digest is retained.

With `compression: "zstd"`, the provider uses Node's built-in zstd codec when
available and otherwise looks for the `zstd` command. A compressed upload is
published only when it is smaller and round-trips to the original artifact.
If no codec is available, disk space is insufficient, or the round-trip check
fails, the successful native build is cached normally without compression.

LAN sharing is also deliberately opt-in. Keep `lan: "off"` for local-only
operation, use `"read"` to fetch from paired peers, or `"read-write"` to fetch
and offer newly published entries. Pairing secrets and peer identities are
managed by the CLI and never belong in Expo config.

## Trusted LAN Cache

On the machine that will serve a cache, run the foreground server and open a
single-use pairing window:

```bash
npx eas-local-cache serve --host 0.0.0.0 --advertise-host 192.168.1.20 \
  --pairing --allow-write
```

On another machine in the same Expo project, run `pair` and paste the URI into
the non-echoing prompt:

```bash
npx eas-local-cache pair
npx eas-local-cache peers --check
```

Then set `lan` to `"read"` or `"read-write"` in the provider options. Local
entries are always checked first. A remote entry is downloaded over pinned TLS,
authenticated with a revocable per-peer credential, verified against its
manifest and checksums, and atomically published into the local cache before it
is returned to Expo. If discovery, authentication, transfer, or the peer itself
is unavailable, Expo simply continues with the normal local build.

The server exposes exact cache identities only; it cannot list another
project's cache. Discovery advertisements contain no project name, path,
fingerprint, entry ID, token, or key. Use `npx eas-local-cache peers` to inspect
trust, and `peers disable`, `peers enable`, or `peers revoke` to manage it.

## How It Works

1. Expo calculates a fingerprint from the native build inputs.
2. `eas-local-cache` derives a versioned identity from that fingerprint, the
   build profile, and deterministic local toolchain signals, then validates the
   matching entry in `<projectRoot>/.expo/cache`.
3. On a cache hit, Expo installs and launches the stored artifact. Compressed
   entries are first materialized into an atomic, integrity-checked restore
   directory that later hits can reuse.
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

Environment-aware keys never fall back to older entries that lack toolchain
context, so the first safe-mode build is an intentional cold miss. Discovery is
bounded, read-only, and fail-open: an unavailable required signal simply makes
Expo perform an uncached build.

After a successful upload, LAN import, materialized restore, or a periodically
throttled ordinary hit, automatic maintenance removes expired data first and
then least-recently-used entries until the size and entry-count soft caps are
satisfied. The hit throttle is persisted across Expo CLI processes, while a
policy change bypasses it. Expired materialized restores are reclaimed as well,
and deleting a compressed source entry also deletes its corresponding restore.
The new artifact, recently returned artifacts, and active builds are protected.
Maintenance failure never turns a successful native build into an error. The
size cap covers valid and invalid entries, upload and restore staging,
materialized restores, quarantine, and trash. Operational metadata and
backward-compatible legacy entries are reported by `stats` but are not deleted
automatically.

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
`list` is newest-first and identifies each entry's `none` or `zstd` encoding;
JSON output also includes logical, payload, gross-savings, and
materialized-restore byte counts. `stats` highlights the latest cached build,
while `stats --json` exposes it as `latestBuild` and aggregates compressed entry
count, gross saved bytes, restore bytes, and net saved bytes. `doctor` performs
the same identity and integrity checks used by cache resolution without changing
the cache. `prune --dry-run` uses the same planner as real and automatic cleanup,
including restore data.
Stats also report exact bytes and counts plus hit rate for retained local
decisions. Estimated time saved uses a conservative native-artifact timestamp
sample; a hit without reliable timing remains explicitly unknown. Telemetry is
retained for 90 days and at most 10,000 events, independent of `autoPrune`.

The cache is resolved from the project root supplied by Expo, not the current
working directory. This keeps caches isolated when commands are run from a
subdirectory, monorepo root, or with a custom project root.

## Cache Storage

Versioned artifacts are stored under `.expo/cache/eas-local-cache/v1`:

| Path                | Purpose                                       |
| ------------------- | --------------------------------------------- |
| `entries/`          | Immutable platform artifacts and manifests    |
| `staging/`          | Incomplete uploads, never used for cache hits |
| `restores/`         | Atomic materializations of compressed entries |
| `locks/`            | Per-entry writer coordination                 |
| `quarantine/`       | Invalid entries retained for diagnosis        |
| `access/`           | Atomic last-used records and short leases     |
| `events/`           | Bounded, private resolve telemetry            |
| `state/`            | Last valid cleanup policy                     |
| `trash/`            | Atomic removal tombstones                     |
| `transfer-staging/` | Incomplete authenticated LAN transfers        |
| `transfer-locks/`   | Per-entry LAN transfer coordination           |

An uncompressed entry contains `artifact.app` or `artifact.apk`. A compressed
entry instead contains `artifact.app.zst` or `artifact.apk.zst` and a versioned
manifest describing the logical artifact and payload checksums. Both formats
may include privacy-safe `insight.json`. The directory name is a SHA-256 cache
identity, so fingerprint values never become raw filesystem paths. Flat
`ios_<fingerprint>.app` and
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
- LAN sharing requires both machines to be reachable while the foreground
  server is running. It does not traverse NAT or provide cloud persistence.

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

### Compression falls back to a normal entry

Compression never blocks a usable native build. Install the `zstd` command or
run Expo with a Node.js release that exposes the built-in zstd codec, then
confirm it is visible in the same shell that starts Expo. The provider also
falls back when the compressed payload would not save space or there is not
enough temporary disk capacity for a verified round trip.

If a compressed entry cannot be decoded on a later machine state, it is treated
as a cache miss. Expo rebuilds normally and replaces it with a readable entry.
A damaged payload is quarantined instead of being returned to Expo.

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
# opt-in zstd miss → restore hit → verified rematerialized hit
EAS_LOCAL_CACHE_TEST_DEVICE=generic bun run --cwd example cache:test:compression:ios
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
