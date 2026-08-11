# Contributing to eas-local-cache

Thanks for your interest in improving the plugin. This document covers how to
run it locally, what the checks are, and how releases work.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## What this project is

`eas-local-cache` implements Expo's `BuildCacheProviderPlugin` interface. Expo
CLI calls two functions:

- `resolveBuildCache` — given a fingerprint hash and platform, return the path
  to a cached artifact or `null`.
- `uploadBuildCache` — given a freshly built artifact, copy it into the cache
  and return where it landed.

Everything lives in a single file, `src/index.ts`. Artifacts are stored under
`.expo/cache` in the project root as `ios_<hash>.app` (a directory) or
`android_<hash>.apk` (a file).

Fingerprint hashes are computed by Expo, not by this plugin. If two builds you
expect to match produce different hashes, that is upstream behaviour — see
[Expo's build cache documentation](https://docs.expo.dev/guides/cache-builds-remotely/).

## Prerequisites

- [Bun](https://bun.sh) 1.1 or newer
- Node.js 20 or newer (used by `npm pack` / publishing)
- macOS if you want to exercise the `ditto` copy path; Linux falls back to `cp -R`

## Local setup

```bash
git clone https://github.com/dennytosp/eas-local-cache.git
cd eas-local-cache
bun install
```

## The checks

These are exactly what CI runs on every pull request, on both Ubuntu and macOS:

```bash
bun run typecheck   # tsc --noEmit over src/ and test/
bun test            # integration tests against a temporary project root
bun run build       # tsc -> build/
```

### About the tests

`test/plugin.test.ts` drives the real plugin against a real filesystem: it
creates a temporary project root, `chdir`s into it *before* importing the module
(the cache directory is resolved from `process.cwd()` at load time), then
exercises cache misses, `.apk` file caching, `.app` bundle caching, overwrites,
and full round trips.

No mocking of `fs` — the tests would not catch a broken `ditto`/`cp` fallback
otherwise, which is the part most likely to break across platforms.

## Trying it in a real project

The most useful manual test is a real Expo app:

```bash
cd eas-local-cache
bun run build
bun link

cd ../your-expo-app
bun link eas-local-cache
```

Then add the provider to `app.config.ts`:

```typescript
experiments: {
  buildCacheProvider: {
    plugin: 'eas-local-cache',
  },
}
```

Run `npx expo run:ios` twice. The second run should print `Cache hit!` and skip
the build. `rm -rf .expo/cache` resets it.

## Pull requests

1. Branch off `main`, e.g. `fix/stale-ios-bundle`.
2. Keep the change focused.
3. Run the three checks above.
4. Fill in the PR template, including what you verified end to end.
5. Add an entry to [CHANGELOG.md](./CHANGELOG.md) under `Unreleased`.

Commit messages use a gitmoji + short summary style
(`:sparkles: Initialize | Expo builds local cache`), but this is not enforced.

## Things to be careful about

- **Cache correctness beats cache hits.** A wrong artifact reused is far worse
  than a rebuild. When in doubt, return `null`.
- **Never delete outside `.expo/cache`.** `uploadBuildCache` removes an existing
  destination before copying; keep that strictly scoped to the cache directory.
- **Keep the dependency list empty.** The plugin runs inside the user's build,
  and today ships zero runtime dependencies. Node's stdlib should be enough.

## Releasing

Maintainers only. Merging a version bump into `main` is what releases —
there is no separate publish step to remember.

1. In a pull request: move the `Unreleased` entries in `CHANGELOG.md` under the
   new version, and bump `package.json`.

   ```bash
   npm version minor --no-git-tag-version   # or patch / major
   ```

   `--no-git-tag-version` matters: the tag is created by CI after a successful
   publish, so it never points at a release that failed halfway.

2. Merge the pull request.

The [Release workflow](./.github/workflows/release.yml) then compares
`package.json` against the registry. If that version is already on npm it stops;
otherwise it re-runs typecheck, tests and build on Ubuntu, publishes with
provenance, pushes the `v<version>` tag, and opens a GitHub Release using the
matching `CHANGELOG.md` section.

Choosing the version number stays a human decision — nothing infers semver from
commit messages. The plugin's public surface is the `BuildCacheProviderPlugin`
contract, so a change to what `resolveBuildCache` returns, or to the cache key
layout, is breaking even though the file is small.

## Questions

Open a [Discussion](https://github.com/dennytosp/eas-local-cache/discussions)
for usage questions, and an issue for bugs.
