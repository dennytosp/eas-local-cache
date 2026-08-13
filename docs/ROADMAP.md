# Product Roadmap

`eas-local-cache` aims to provide an offline, self-managing, and explainable
build cache for local Expo development. The roadmap deliberately preserves the
package's local-first, zero-account positioning.

## Milestone 1: Reliable Cache

Status: implemented in pull request #18.

- Versioned cache entries with a manifest and integrity digest
- Atomic publication from a staging directory
- Writer locking and stale-lock recovery
- Corrupt-entry quarantine and legacy cache compatibility
- HeroUI Native and Uniwind Expo example used for end-to-end verification

## Milestone 2: Self-Managing Cache

Status: implemented on `feat/cache-inspector`.

- `list`, `stats`, `doctor`, and `prune` CLI commands
- Explicit size, entry-count, and retention limits
- LRU cleanup based on library-owned access metadata
- Dry-run output and protection for active entries

## Milestone 3: Explainable Cache

Status: implemented on `feat/explain-cache-miss`.

- Persist comparable fingerprint input snapshots
- Compare a miss with the closest compatible previous entry
- Report evidence-backed changed input groups as possible miss causes
- Measure hit rate and estimated build time avoided without overstating accuracy

## Milestone 4: Environment-Safe Cache

Status: implemented on `feat/environment-safe-cache`.

- Derive a storage key from Expo's fingerprint plus relevant run options
- Add carefully selected Xcode, SDK, JDK, Gradle, and architecture compatibility
  signals
- Keep strict toolchain keying opt-in where compatibility is uncertain

## Milestone 5: Storage Efficiency

- Optional zstd compression for artifacts at rest
- Bounded, atomic restore staging for Expo-compatible artifact paths
- Compression savings visible in Cache Inspector output
- Automatic fallback when zstd is unavailable or compressed data is damaged

## Milestone 6: Trusted LAN Cache

- Opt-in `serve` and `pair` workflow instead of ambient peer trust
- Authenticated peer discovery and transfer
- Manifest and checksum verification before local promotion
- Local cache remains the first tier and the library continues to work offline

Each milestone is delivered as a separately reviewable pull request and must be
verified against the repository test suite and the example app.
