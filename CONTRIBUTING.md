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

Merging a pull request into `main` is what releases. There is no separate
publish step to remember, and no version number to type.

**How the version is chosen.** Label the pull request:

| Label | 1.2.3 becomes | Use for |
| --- | --- | --- |
| *(none)* | `1.2.4` | bug fixes, docs, internals |
| `release:minor` | `1.3.0` | new behaviour that stays compatible |
| `release:major` | `2.0.0` | anything that breaks existing setups |
| `release:skip` | unchanged | nothing published at all |

The public surface here is the `BuildCacheProviderPlugin` contract, so a change
to what `resolveBuildCache` returns, or to the cache key layout, is
`release:major` even though the file is small — a changed key layout silently
invalidates every cache entry a user already has.

**What happens.** The [bump workflow](./.github/workflows/bump.yml) writes the
new version and moves your `Unreleased` CHANGELOG entries under it, committing
`:bookmark: Bump version to <version>` to the pull request branch. You see the
exact number and notes before merging, and can edit them.

Merging carries that commit onto `main`, where the
[release workflow](./.github/workflows/release.yml) sees a version the registry
does not have yet, re-runs typecheck/tests/build on Ubuntu, publishes with
provenance, pushes the `v<version>` tag, and opens a GitHub Release from the
CHANGELOG section.

The target is always computed from `main`, never from the branch, so
re-labelling is safe: minor, then major, then minor again lands on the same
number it would have the first time.

**Two things worth knowing.**

CI does not re-run on the bump commit — pushes made with `GITHUB_TOKEN` do not
start workflow runs. That commit only rewrites the version field and moves a
CHANGELOG heading; the code CI verified is unchanged.

Pull requests from forks are not bumped, because the bot cannot push to a
fork's branch. Release those by bumping by hand after the merge, or by moving
the branch into this repository.

## Questions

Open a [Discussion](https://github.com/dennytosp/eas-local-cache/discussions)
for usage questions, and an issue for bugs.
