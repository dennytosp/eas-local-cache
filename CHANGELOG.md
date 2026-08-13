# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Versioned cache manifests with SHA-256 integrity checks for Android artifacts
  and deterministic tree checks for iOS app bundles.
- Atomic cache publication, per-entry writer locks, stale-lock recovery, and
  corrupt-entry quarantine so interrupted or concurrent writes cannot be
  returned as cache hits.
- A HeroUI Native and Uniwind Expo example that links the local package and
  provides repeatable iOS Simulator and Android emulator cache tests.
- Repository guidance, cache correctness rules, and a milestone roadmap for
  cache inspection, retention, explainable misses, toolchain-safe keys, and
  trusted LAN sharing.
- A Cache Inspector CLI with `stats`, `list`, `doctor`, and `prune` commands,
  including JSON output and a non-mutating prune preview.
- Atomic last-access metadata and automatic TTL/LRU cleanup with configurable
  size and entry-count soft caps.
- Privacy-safe Expo fingerprint snapshots and evidence-backed cache-miss
  explanations without persisting raw config or source contents.
- Bounded per-resolve telemetry with retained hit rate, lookup duration, and a
  conservative artifact-timestamp estimate of native build time avoided.
- Versioned environment-aware identities that separate build profiles,
  Xcode/Simulator SDKs, JDK/Gradle versions, and Android target ABIs.
- Safe, strict, and compatibility-off toolchain modes plus a privacy-preserving
  optional manual environment key.
- Opt-in zstd compression for Android APKs and deterministic iOS app-tree
  archives, with bounded codec operations and verified round trips before
  publication.
- Atomic, reusable restore directories for compressed entries, including
  integrity validation, corruption quarantine, and uncompressed fallback when
  a decoder or sufficient temporary disk space is unavailable.
- Compression accounting in Cache Inspector list and stats output, plus restore
  awareness in automatic and manual cleanup.
- Opt-in trusted LAN sharing with pinned TLS, explicit one-use pairing,
  per-peer authentication and revocation, and checksum-verified atomic local
  promotion.

### Changed

- Toolchain-aware cache identities are now opt-in. The default `toolchain`
  mode is `off`; projects can select `safe` or `strict` when environment-level
  cache separation is required.
- Dependabot updates now skip npm publishing by default. Explicit package
  version increases publish after required CI, while version decreases are
  rejected.
- New cache uploads use the versioned `.expo/cache/eas-local-cache/v1` layout.
  Existing flat `.apk` and `.app` entries remain readable as unverified legacy
  cache entries.
- Cache uploads now default to a 20 GiB, 50-entry, 14-day retention policy and
  clean expired quarantine, staging, trash, and least-recently-used entries
  without failing the native build.

## [1.0.4] - 2026-08-11

### Fixed

- The cache directory was resolved from `process.cwd()` at module load instead
  of from the `projectRoot` Expo passes in. Those differ whenever the CLI runs
  from a subdirectory, from a monorepo root, or with `--project-root`, and the
  result was a cache written somewhere the next build never looked — a silent
  permanent cache miss rather than a visible error.

### Added

- MIT `LICENSE` file (the package was already declared MIT in `package.json`).
- Continuous integration on Ubuntu and macOS: typecheck, integration tests,
  build, and package verification on every push and pull request.
- Integration tests covering cache miss, `.apk` file caching, `.app` bundle
  caching, overwrite, and round-trip resolve.
- Label-driven releases. A pull request labelled `release:minor` /
  `release:major` (or left unlabelled, for a patch) gets its version and
  CHANGELOG section written into the branch before merge; merging then
  publishes to npm with provenance, pushes the `v<version>` tag, and opens a
  GitHub Release from this file. `release:skip` publishes nothing.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and pull request
  templates, and Dependabot configuration.

### Changed

- `@expo/config` is now an explicit devDependency instead of being picked up
  transitively through `expo-module-scripts`.

## [1.0.3] - 2025-10-09

### Fixed

- Corrected the documented cache directory path in the README.

## [1.0.2] - 2025-09-02

### Changed

- Clarified installation instructions in the README.

## [1.0.1] - 2025-09-02

### Added

- README documenting configuration, cache layout, and troubleshooting.

## [1.0.0] - 2025-09-02

### Added

- Initial release: a `BuildCacheProviderPlugin` for Expo CLI that stores build
  artifacts under `.expo/cache`, keyed by fingerprint hash and platform.
  Handles iOS `.app` bundles as directories (via `ditto`, falling back to
  `cp -R`) and Android `.apk` files as single files.

[unreleased]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dennytosp/eas-local-cache/releases/tag/v1.0.0
