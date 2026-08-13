# EAS Local Cache

[![CI](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/dennytosp/eas-local-cache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/eas-local-cache.svg)](https://www.npmjs.com/package/eas-local-cache)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Reuse native `.app` and `.apk` artifacts for repeated local Expo builds.

```text
First expo run   → native build → save artifact
Same fingerprint → cache hit    → skip Xcode/Gradle compilation
Changed input    → cache miss   → build and save a new artifact
```

This package is local-first, requires no EAS account, and is never imported by
the React Native application.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | 18 or newer |
| Project | Expo project whose CLI supports `buildCacheProvider` |
| Commands | `npx expo run:ios` or `npx expo run:android` |
| iOS | macOS, Xcode, and an iOS Simulator build |
| Android | JDK and Android SDK required by `expo run:android` |

Supported project types:

| Project/workflow | Supported? |
| --- | ---: |
| Expo managed or prebuild | Yes |
| Bare project using Expo CLI `expo run:*` | Yes |
| Pure React Native CLI `react-native run-*` | No |
| `eas build` or `eas build --local` | No |

Supported build targets:

| Target | Cache supported? |
| --- | ---: |
| Android Emulator | Yes |
| Android physical device | Yes |
| iOS Simulator | Yes |
| iPhone or iPad physical device | No; Expo CLI skips build-cache providers for physical iOS builds |

The physical iOS limitation comes from Expo CLI, not this package. See Expo's
[build cache provider limitations](https://docs.expo.dev/guides/cache-builds-remotely/#limitations).

## Install

```bash
npm install --save-dev eas-local-cache
```

Add the provider to `app.json`:

```json
{
  "expo": {
    "buildCacheProvider": {
      "plugin": "eas-local-cache"
    }
  }
}
```

Then run Expo normally:

```bash
npx expo run:ios
npx expo run:android
```

The first run builds and caches the native artifact. A later run with the same
fingerprint uses that artifact instead of compiling native code again.

## Options

All options are optional:

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
        "toolchain": "off",
        "compression": "off",
        "lan": "off"
      }
    }
  }
}
```

| Option | Type / values | Default | Purpose |
| --- | --- | ---: | --- |
| `maxSize` | size, bytes, or `null` | `"20GB"` | Maximum managed cache size. `null` disables this limit. |
| `maxEntries` | non-negative integer or `null` | `50` | Maximum cached builds. `null` disables this limit. |
| `retentionDays` | non-negative number or `null` | `14` | Remove entries unused beyond this age. `null` disables expiry. |
| `autoPrune` | boolean | `true` | Apply TTL, LRU, size, and entry limits automatically. |
| `toolchain` | `"off"`, `"safe"`, `"strict"` | `"off"` | Optionally separate cache entries by build environment. |
| `environmentKey` | string | unset | Add a project-defined native build context to the cache identity. |
| `compression` | `"off"`, `"zstd"` | `"off"` | Compress cached artifacts at rest. |
| `lan` | `"off"`, `"read"`, `"read-write"` | `"off"` | Share matching entries with explicitly paired peers. |

Size suffixes use binary units: `KB`, `MB`, `GB`, and `TB`.

### `toolchain`

| Value | Behavior |
| --- | --- |
| `off` | Use Expo's fingerprint. Best hit rate and default Expo compatibility. |
| `safe` | Also separate by build profile and primary Xcode/SDK/JDK/Gradle/ABI signals. |
| `strict` | Add more exact toolchain versions for stronger environment isolation. |

Use `safe` or `strict` when artifacts built by different toolchains must not
share a cache entry. These modes improve correctness, not hit rate.

Use `environmentKey` when a custom environment value changes native output but
is not represented by Expo's fingerprint:

```js
options: {
  environmentKey: process.env.NATIVE_FLAVOR ?? "default"
}
```

Only its SHA-256 digest is stored.

### `compression`

`zstd` requires either Node's built-in zstd codec or a `zstd` executable on
`PATH`. If compression is unavailable, unsafe, or does not save space, the
artifact is cached uncompressed. A usable native build is never failed because
compression failed.

### `lan`

| Value | Behavior |
| --- | --- |
| `off` | Local cache only. |
| `read` | Download matching entries from paired peers after a local miss. |
| `read-write` | Download and upload matching entries to paired peers. |

LAN sharing is direct peer-to-peer, not cloud storage. Peers must be reachable
on the same LAN or a routed VPN. Existing local entries continue to work
offline.

Start a server and open a one-use pairing window:

```bash
npx eas-local-cache serve \
  --host 0.0.0.0 \
  --advertise-host 192.168.1.20 \
  --pairing \
  --allow-write
```

On the other machine:

```bash
npx eas-local-cache pair
npx eas-local-cache peers --check
```

Pairing uses pinned TLS and per-peer authentication. If a peer is offline or a
transfer fails, Expo continues with the local cache or a normal native build.

## What happens on a cache miss?

The build continues normally. The provider can print a short possible cause,
such as:

```text
Possible cause: Expo config or config plugins changed
Possible cause: native dependencies or autolinking changed
Possible cause: build configuration changed
```

After a successful build, the new artifact is checksummed and atomically
published. Partial or corrupt entries are never returned; they are quarantined
and treated as misses.

## Cache Inspector

| Command | Purpose |
| --- | --- |
| `npx eas-local-cache stats` | Size, entry count, hit rate, and estimated time saved. |
| `npx eas-local-cache list` | List cached builds, platform, age, size, and encoding. |
| `npx eas-local-cache doctor` | Validate manifests, artifacts, metadata, and LAN state. |
| `npx eas-local-cache doctor --deep` | Also verify compressed payload restoration. |
| `npx eas-local-cache prune --dry-run` | Preview cleanup. |
| `npx eas-local-cache prune` | Remove entries using configured or supplied limits. |

Add `--json` for machine-readable output and `--project-root <path>` when run
outside the Expo project directory.

Cache data is stored under:

```text
<projectRoot>/.expo/cache/eas-local-cache/
```

Do not commit this directory.

## Important behavior

- Local cache does not depend on Wi-Fi, IP address, or a running LAN server.
- LAN is checked only after a local miss.
- Cache entries are project-scoped; a second clone has a separate cache.
- Changing native dependencies, Expo config, build inputs, or an enabled
  toolchain identity creates a miss and a new entry.
- Cleanup protects active and recently returned entries.
- Cache, telemetry, compression, and LAN failures fail open: Expo performs a
  normal native build instead of failing the app build.

## Troubleshooting

**No cache hit**

- Confirm `buildCacheProvider` is under `expo`, not `experiments`.
- Confirm the command is `expo run:ios` or `expo run:android`.
- Check the CLI output for `Cache miss` and `Possible cause`.
- Run `npx eas-local-cache doctor`.

**Clear only this provider's cache**

```bash
rm -rf .expo/cache/eas-local-cache
```

## Development

The [`example`](./example) Expo app is the native end-to-end fixture.

```bash
bun install
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run example:check
```

See [CONTRIBUTING.md](./CONTRIBUTING.md),
[SECURITY.md](./SECURITY.md), and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
