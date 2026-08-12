# Local Cache Roadmap Design

## Goal

Evolve `eas-local-cache` from a minimal filesystem copy provider into a reliable,
self-managing, explainable cache while preserving its defining properties:
offline operation, no account, no remote upload, and direct integration with
local `npx expo run:ios` and `npx expo run:android` commands.

## Delivery Strategy

The work is split into five stacked milestones documented in
`docs/ROADMAP.md`. Each milestone remains useful on its own, includes tests, is
exercised through the repository example, and is published as a focused pull
request. Later milestones build on stable metadata and storage primitives from
the earlier ones.

## Milestone 1 Architecture

The provider retains the Expo adapter in `src/index.ts` and moves filesystem
behavior into small modules with explicit boundaries:

- cache layout: maps a project root and cache identity to versioned paths;
- integrity: describes and verifies Android files and iOS app directories;
- lock: gives a single writer ownership of a cache identity and recovers stale
  process locks;
- entry store: resolves, publishes, quarantines, and reads legacy artifacts.

New entries live below `.expo/cache/eas-local-cache/v1/`. An entry directory
contains one platform artifact and a `manifest.json`. Its manifest records the
schema version, platform, Expo fingerprint, relative artifact path and type,
byte size, file count, SHA-256 digest, and creation timestamp.

Uploads first acquire a key-scoped lock. They copy into a sibling staging
directory, compute integrity from the copied artifact, write the manifest, and
rename the complete entry into its final immutable location. A competing writer
uses the published valid entry when available and otherwise fails open without
interrupting Expo's native build. Stale locks are recoverable after a bounded
age and include enough metadata for diagnostics.

Resolution validates the manifest identity, artifact type, aggregate metadata,
and digest before returning the artifact path. An invalid versioned entry is
moved under a quarantine directory when no live writer owns it, then treated as
a miss. Existing top-level `android_<hash>.apk` and `ios_<hash>.app` artifacts
remain readable through an explicit legacy fallback.

## Example App

`example/` is a small Expo Router application using HeroUI Native and Uniwind.
It declares the repository root package as a local development dependency and
configures `buildCacheProvider.plugin` as `eas-local-cache`. The app is not a
showcase product; its purpose is to provide a realistic native dependency graph
and a repeatable miss/upload/hit test on iOS Simulator and Android emulator.

Static validation checks package resolution, Expo config evaluation, Metro
configuration, and TypeScript. Native verification runs the same `expo run`
command twice and checks provider logs plus the versioned cache entry.

## Failure Handling

All provider failures are cache misses or failed uploads, never native-build
failures. Temporary files and stale locks may survive a process interruption,
but incomplete data is never published as a valid entry. Error messages name
the cache identity and actionable reason without printing secrets or dumping
large errors.

## Testing

The store is tested with temporary project roots and fake `.apk`/`.app`
artifacts. Coverage includes cache miss and round trip, integrity corruption,
partial publication, lock contention, stale-lock recovery, quarantine,
platform isolation, legacy reads, and unrelated working directories. Existing
release-decision tests remain unchanged.

## Later Milestones

The CLI and eviction policy consume manifests rather than reconstructing state
from filenames. Explainable misses add fingerprint snapshots beside immutable
entries and describe only evidence that can be reproduced. Toolchain-aware keys
extend Expo's supplied fingerprint at the storage layer rather than replacing
Expo's fingerprint calculation. LAN sharing exposes the same verified entry
format through an explicitly paired transport; it never weakens local integrity
checks or becomes required for offline operation.
