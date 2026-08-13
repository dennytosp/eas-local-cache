# Environment-Safe Cache Implementation Plan

## Delivery boundary

Implement Milestone 4 as one stacked feature commit after the approved design
commit. Preserve the manifest/store format and extend only optional insight
metadata plus provider fingerprint calculation.

## Work packages

1. **Options and effective identity**

   - Extend provider options with `toolchain` and `environmentKey` validation.
   - Add canonical environment payload serialization and versioned effective
     hashing.
   - Preserve exact Expo hash parity for `off` without a manual key.
   - Unit-test deterministic ordering, mode behavior, separation, and privacy.

2. **Bounded toolchain discovery**

   - Add an injectable, shell-free command runner with timeout and output caps.
   - Discover validated iOS Xcode/Simulator SDK signals.
   - Discover validated Android Java, Gradle wrapper, online target, and ABI
     signals without executing Gradle or mutating the project.
   - Add fixtures for selectors, ordered ABIs, failures, strict fields, and
     sanitized memoization.

3. **Insight schema and explanations**

   - Introduce schema-2 insights with base/effective identities and sanitized
     environment evidence.
   - Normalize schema-1 reads into an explicit Expo-base diagnostic view.
   - Rank environment-aware candidates deterministically and emit fixed,
     environment-first cause groups.
   - Keep optional insight failures independent of artifact validity.

4. **Provider lifecycle integration**

   - Calculate Expo base evidence and environment identity together in both
     Expo callback phases.
   - Key bounded lifecycle state by effective identity and prevent changed or
     ambiguous contexts from inheriting timing.
   - Fail open with a concise warning when required discovery is unavailable.
   - Preserve cleanup, telemetry, and direct store-reason priority.

5. **CLI, example, and documentation**
   - Surface key schema and environment mode in list/doctor output where useful.
   - Configure the example for default safe mode and verify option resolution.
   - Add a build-only iOS Debug/Debug/Release/Release oracle with exact
     telemetry and privacy assertions.
   - Update README, changelog, and roadmap status.

## Verification

- Focused unit and integration tests for every work package.
- Full format, lint, typecheck, unit-test, and package-build gates.
- Example static check and iOS Expo export.
- Packed-tarball installation into an isolated consumer.
- iOS generic native Debug miss/hit then Release explained miss/hit.
- Android static/discovery tests; run native Android oracle when an emulator is
  available.
- Independent code review, one implementation commit, stacked pull request,
  and GitHub CI monitored to completion.
