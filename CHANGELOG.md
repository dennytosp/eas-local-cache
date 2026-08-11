# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/dennytosp/eas-local-cache/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dennytosp/eas-local-cache/releases/tag/v1.0.0
