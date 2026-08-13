# EAS Local Cache example

This Expo app is the end-to-end fixture for the package in the repository root. It uses
[HeroUI Native](https://heroui.com/docs/native) with
[Uniwind](https://docs.uniwind.dev) and loads `eas-local-cache` through a local
`file:..` development dependency.

The provider runs in Expo CLI during native builds. It is not imported by the React Native
runtime, so the terminal output—not the rendered screen—is the source of truth for cache
behavior.

The example also configures the default 20 GiB, 50-entry, 14-day cleanup policy
and keeps compression off unless a compression test explicitly opts in.

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

The verification checks the integration points:

- `package.json` links `eas-local-cache` from the repository root.
- `app.json` configures `expo.buildCacheProvider` with that package.
- The built package exports `calculateFingerprintHash`, `resolveBuildCache`, and
  `uploadBuildCache`.
- The package exposes the `eas-local-cache` inspector binary.
- A conditional `EAS_LOCAL_CACHE_TEST_SALT` changes evaluated Expo config
  without editing tracked or native files.
- A conditional `EAS_LOCAL_CACHE_TEST_COMPRESSION=zstd` enables the compression
  oracle while normal example builds retain the package default.
- A conditional `EAS_LOCAL_CACHE_TEST_LAN=read|read-write` enables the trusted
  LAN oracle while ordinary example builds remain local-only.

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

Inspect the real cache created by native example builds:

```bash
bun run cache:stats
bun run cache:list
bun run cache:doctor
bun run cache:prune
```

`cache:list` shows each entry's `none` or `zstd` encoding. Use
`bun run cache:stats -- --json` to inspect aggregate gross compression savings,
materialized restore bytes, and net savings. `cache:doctor` validates cache
identity and entry integrity without modifying the cache. `cache:prune` is a
dry run in this fixture, so it includes reclaimable entries and expired restore
data in a real cleanup plan without removing artifacts used by the next hit
test.

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

## Test an explained cache miss

The automated native oracle generates two non-secret per-run config tokens and
runs A miss → A hit → B explained miss → B hit:

```bash
bun run cache:test:ios
# or, with an Android emulator already running
bun run cache:test:android
```

Set `EAS_LOCAL_CACHE_TEST_DEVICE` to `generic` for an iOS build-only run, an iOS
Simulator UDID for an install-and-launch run, or an Android emulator serial
when more than one target is available.

The B miss must identify Expo configuration as a possible cause. The script
also requires exactly two new misses and two new hits, scans diagnostics for
token leaks, and requires a healthy cache at the end. Tokens are not written to
insight or event metadata; they only make Expo's evaluated config fingerprint
change.

## Test environment-safe keys

The environment oracle keeps Expo inputs constant while changing the native
build profile. On iOS it runs Debug miss → Debug hit → Release explained miss →
Release hit:

```bash
EAS_LOCAL_CACHE_TEST_DEVICE=generic bun run cache:test:environment:ios
```

With an Android emulator, `bun run cache:test:environment:android` compares a
targeted debug artifact with an all-architecture debug artifact. Both scripts
assert two hits, two misses, diagnostic privacy, and a healthy cache.

## Test compressed storage and restore

Compression is opt-in and requires either Node's built-in zstd codec or a
working `zstd` executable on `PATH`. Check the external decoder with `zstd -V`
when the Node.js runtime used by Expo does not expose zstd itself.

The compression oracle creates a unique Expo fingerprint, enables
`compression: "zstd"`, and runs one native miss followed by two identical
hits. Between the hits it removes only that run's materialized restore, so the
third build must recreate the restore from the compressed source entry:

```bash
# Build-only iOS run; use a Simulator UDID to install and launch instead.
EAS_LOCAL_CACHE_TEST_DEVICE=generic bun run cache:test:compression:ios

# Or start an Android emulator first.
bun run cache:test:compression:android
```

It requires the upload log to end in `.zst`, requires both hits to come from the
atomic `restores/` area, and checks that the second hit rematerialized the exact
owned restore. It also checks telemetry plus `list`, `stats`, and `doctor`
output, and verifies that the per-run config token was not persisted in
diagnostic metadata.

If a codec is unavailable during an ordinary build, compression fails open:
the provider logs the reason and stores the successful artifact uncompressed.
If a previously compressed entry cannot be decoded, the lookup becomes a miss
so Expo can rebuild and replace it. Corrupt compressed payloads are quarantined
rather than returned to Expo.

## Test trusted LAN sharing

The LAN oracle uses a temporary loopback peer with a one-use pairing file. It
runs one native local miss, moves only that new entry into the temporary peer,
and removes the local copy. The second identical build must fetch, authenticate,
verify, and atomically promote that entry. After the server stops, a third build
must hit the promoted local entry without network access:

```bash
# Build-only iOS run; use a Simulator UDID to install and launch instead.
EAS_LOCAL_CACHE_TEST_DEVICE=generic bun run cache:test:lan:ios

# Or start an Android emulator first.
bun run cache:test:lan:android
```

The script preserves any existing local LAN trust state, checks the exact
miss/hit telemetry delta, scans diagnostics for the non-secret test token, and
requires `doctor` to finish healthy.
