# Repository Guide

## Purpose

`eas-local-cache` is an offline build-cache provider for local Expo CLI builds.
It integrates with `npx expo run:ios` and `npx expo run:android`; it is not an
`eas build` or `eas build --local` cache hook.

## Commands

- Install: `bun install`
- Format: `bun run format`
- Format check: `bun run format:check`
- Lint: `bun run lint`
- Type-check: `bun run typecheck`
- Test: `bun test`
- Build package: `bun run build`
- Verify example config: `bun run example:check`

Run the focused checks while iterating and the complete validation suite before
committing. Native changes must also be exercised through the app under
`example/` whenever the required simulator or emulator is available.

## Project Boundaries

- Treat `docs/superpowers/specs/` as local-only design scratch space. Never
  stage or commit files from this directory; remove any historically tracked
  spec from Git while preserving the local file when practical.
- Keep the provider runtime Node-only. It must never be imported into the React
  Native application bundle.
- Resolve every cache path from the `projectRoot` supplied by Expo, never from
  `process.cwd()`.
- Treat cache entries as untrusted filesystem data. Validate before returning a
  path to Expo and fail open with a cache miss instead of breaking the build.
- Keep new on-disk formats versioned and retain explicit compatibility for
  supported legacy entries.
- Put reusable cache logic in focused modules under `src/`; keep `src/index.ts`
  limited to the Expo provider adapter.
- Add or update tests for every cache-format, concurrency, recovery, or keying
  behavior change.

## Example App

The Expo app in `example/` is the end-to-end fixture. It uses HeroUI Native with
Uniwind and references the repository package directly. Do not commit generated
`ios/`, `android/`, `.expo/`, or build-cache artifacts. Read
`.agents/rules/example-app.md` before changing it.

## Detailed Rules

- `.agents/rules/cache-correctness.md`
- `.agents/rules/example-app.md`
