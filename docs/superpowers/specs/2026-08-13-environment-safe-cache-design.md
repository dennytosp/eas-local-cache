# Environment-Safe Cache Design

## Goal

Prevent a locally built native artifact from being reused across incompatible
build profiles or toolchains while keeping the provider zero-configuration,
offline, and fail-open. The environment-aware identity extends Expo's own
fingerprint; it does not replace Expo's source selection or weaken the existing
artifact integrity checks.

## Scope

This milestone covers cache identity, diagnostic metadata, miss explanations,
configuration, and repeatable native verification for environment changes. It
does not compress artifacts, share them over a network, infer compatibility
between different toolchain versions, or fall back to an entry that was written
without environment context.

## Chosen Approach

`calculateFingerprintHash` returns one effective, versioned hash derived from a
canonical payload containing Expo's base fingerprint, the platform, the
normalized requested build profile, selected toolchain signals, and an optional
user environment key. Expo then supplies this same effective hash to resolve and
upload, so the current manifest, entry ID, locking, cleanup, and telemetry paths
continue to use one authoritative identity.

The alternatives are rejected for this milestone:

- deriving a second storage key inside resolve and upload would spread identity
  translation across the store, manifest, insights, CLI, and lifecycle state;
- requiring a user-provided salt would be deterministic but would abandon the
  zero-configuration safety goal.

An optional manual environment key remains available as an additive escape
hatch and deterministic test seam.

## Configuration

The provider accepts these additional options:

```json
{
  "toolchain": "safe",
  "environmentKey": "optional-team-defined-context"
}
```

`toolchain` has three modes:

- `safe` is the default. It includes signals with a direct, deterministic
  relationship to the produced artifact.
- `strict` is opt-in. It adds exact runtime and target details where they can be
  discovered without network access or changing the native project. If a
  required strict signal cannot be established unambiguously, caching is
  disabled for that build.
- `off` preserves Expo's base hash exactly when `environmentKey` is absent. It
  exists for explicit compatibility and troubleshooting, not as an automatic
  fallback.

`environmentKey` is optional, at most 512 characters, and may not contain
control characters. Its raw value is hashed immediately and is never logged or
persisted. If it is supplied in `off` mode, the provider still produces a
versioned effective hash containing only Expo's hash and the manual key digest.

Invalid options disable caching for the current build with a concise warning.
They never fail the native build.

## Normalized Build Profile

Only options that affect native output are included. Device identifiers,
ports, bundler flags, binary paths, interactive flags, and arbitrary CLI fields
are excluded.

For iOS the profile is:

- configuration: `Debug` unless explicitly `Release`;
- requested scheme: the bounded string supplied by Expo, otherwise the fixed
  `default` sentinel. A boolean `true` selector means Expo will prompt for a
  scheme that the provider cannot observe and therefore disables caching;
- target family: `iphonesimulator`, because Expo local build caching currently
  excludes physical iOS device builds.

For Android the profile is:

- variant: `debug` unless a bounded variant string is supplied;
- `allArch`: `false` unless explicitly enabled;
- target architecture: `all` for all-architecture or non-debug builds,
  otherwise the ABI discovered from one unambiguous connected target.

Expo does not pass its resolved device back into raw `runOptions`. For an
Android targeted debug build the provider applies these exact matching rules:

- a string device selector must exactly match one online ADB serial or one
  unique bounded device name;
- an absent selector is accepted only when exactly one online target exists;
- boolean `true`, no online target, multiple possible targets, an unauthorized
  target, or an invalid ABI response disables caching;
- the chosen target may report a bounded ordered ABI list. Matching Expo 57,
  the provider selects its first value from `arm64-v8a`, `armeabi-v7a`, `x86`,
  or `x86_64`, and disables caching when none is supported.

The same matching is repeated before upload. This deliberately prefers an
uncached build over correlating the artifact with a device Expo may not have
selected.

These fields describe the requested profile exposed to the provider. The design
does not claim that raw Expo run options contain every resolved CLI default.

## Toolchain Signals

### Safe mode

Common signals:

- platform;
- normalized build profile;
- Node-reported host CPU architecture.

iOS signals:

- Xcode product build version from `xcodebuild -version`;
- iPhone Simulator SDK build version from
  `xcrun --sdk iphonesimulator --show-sdk-build-version`.

Android signals:

- Java specification major version;
- normalized Java vendor family;
- JVM-reported architecture;
- Gradle wrapper distribution version parsed from
  `android/gradle/wrapper/gradle-wrapper.properties`;
- the target ABI resolved by the rules above for targeted debug builds, or the
  fixed `all` token for all-architecture and non-debug builds.

Expo's base fingerprint already tracks project-owned Android SDK declarations
and Gradle wrapper files. Safe mode therefore does not guess which installed
Android SDK package Gradle selected.

### Strict mode

Strict mode includes every safe signal and adds:

- iOS Xcode marketing version and Simulator SDK platform version;
- Android full Java runtime version and VM family;
- the normalized Gradle distribution URL basename and configured distribution
  checksum, when present in wrapper properties.

Environment-key schema v1 intentionally does not run `gradlew`, query Gradle
tasks, or infer compile SDK/build-tools revisions. Expo Gradle plugins can
select those versions dynamically, and wrapper execution can download or
modify local state. Project-owned Gradle files and SDK declarations remain part
of Expo's base fingerprint. A future key schema may add installed Android SDK
signals only when Expo exposes the resolved values directly.

Strict discovery must not invoke a command that can download dependencies,
modify the native project, accept licenses, start an emulator, or install SDK
components. It may read only the existing wrapper properties file and run the
same bounded Xcode, SDK, Java, and ADB queries used by safe discovery. Missing,
ambiguous, or malformed required values return `null` from the fingerprint
callback and let Expo perform an ordinary uncached build.

## Command Execution and Privacy

Toolchain discovery lives behind an injectable command runner. Every command
has a two-second timeout, a 64 KiB combined output limit, no shell expansion,
and a fixed argument list. The overall discovery attempt is bounded to five
seconds. The provider may memoize a successful sanitized snapshot for 30
seconds in the current process.

`DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and executable
selection may influence discovery. Their raw values are never included in the
effective payload, insight, logs, or persistent metadata. Memoization may use an
in-memory digest of selector values.

Persisted signals use fixed field names and validated version/architecture
tokens. The provider never persists absolute tool paths, SDK roots, usernames,
home directories, device IDs, the full environment, or raw command output.
Unknown vendor/VM values map to a fixed `other` family instead of being stored
verbatim.

## Effective Identity

The canonical payload is logically:

```json
{
  "schema": "eas-local-cache/environment-key/v1",
  "baseFingerprintHash": "<Expo hash>",
  "platform": "ios",
  "runProfile": {},
  "toolchainMode": "safe",
  "toolchain": {},
  "environmentKeyDigest": null
}
```

Object keys are serialized in a defined order and values are already normalized
before hashing. The returned identity is
`elc-env-v1:<sha256-of-canonical-payload>`. `off` mode without a manual key is
the only case that returns Expo's base hash unchanged.

The schema prefix makes migrations explicit and prevents collision with Expo
hashes. Effective identities are opaque inputs to `getEntryId`; they are never
interpolated directly into filesystem paths.

The second fingerprint calculation before upload repeats Expo source hashing
and environment discovery. If the base fingerprint or effective environment
identity changed during the build, the upload uses the new identity and cannot
inherit timing state from the pre-build miss.

## Metadata Evolution

Artifact manifests continue to store the effective fingerprint in their
existing `fingerprintHash` field, so the immutable entry format and integrity
contract do not change.

Optional `insight.json` advances to schema version 2 and stores:

- `fingerprintHash`, retained as the effective identity alias used by manifests
  and common validation code;
- `baseFingerprintHash`;
- `effectiveFingerprintHash`;
- `keySchema` (`expo-base` or `environment-v1`);
- toolchain mode;
- normalized run profile;
- sanitized toolchain snapshot;
- existing sanitized Expo source evidence and optional timing estimate.

For schema 2, all three of `fingerprintHash`, `effectiveFingerprintHash`, and the
entry manifest fingerprint must be identical. `baseFingerprintHash` is Expo's
unextended hash. Schema-1 insights remain readable for pre-milestone entries;
their single `fingerprintHash` is interpreted as both base and effective with
`keySchema: expo-base` and no toolchain evidence. A common identity accessor
normalizes both schemas before candidate comparison. A malformed schema-2
insight is reported by `doctor` without invalidating its artifact.

Existing base-hash entries stay listable and pruneable. Environment-aware
resolution never falls back to them because doing so would defeat the safety
property. The first safe-mode build is therefore an intentional cold miss.

## Explain Cache Miss

Direct store evidence such as corruption or a busy writer still has priority.
For an ordinary miss, candidates are restricted to the same platform. Ranking
uses this exact ascending/descending tuple: identical base fingerprint first;
fewest sanitized Expo source differences; fewest environment-field
differences; newest last access; newest creation; lexicographically ascending
entry ID. Schema-1 candidates participate as `expo-base` entries and can explain
an upgrade to the environment-aware schema, but cannot claim a specific
toolchain difference.

Environment explanations use fixed categories:

- build configuration, scheme, variant, or architecture selection changed;
- Xcode changed;
- platform SDK changed;
- JDK changed;
- Gradle changed;
- host or target architecture changed;
- manual environment context changed;
- cache identity upgraded to environment-aware schema.

Environment evidence is reported before Expo source evidence, with no more than
three messages total. Logs say `Possible cause` and do not print raw versions,
paths, hashes, manual keys, or device identifiers.

## Failure Handling

- Expo fingerprint failure returns `null`, as in Milestone 3.
- A required toolchain command timeout, oversized output, malformed result, or
  missing safe signal returns `null`; it never silently drops that signal and
  creates a broader key.
- Optional diagnostic serialization failure may omit insight while retaining a
  successful artifact upload.
- Memoization and lifecycle state remain bounded and fail open.
- Toolchain metadata is never authoritative for artifact integrity; the
  manifest and checksum remain authoritative.

## Testing

Unit tests use an injected command runner and filesystem fixtures to cover:

- deterministic canonical hashing independent of object construction order;
- `off` parity with Expo's hash;
- manual key separation without raw-key persistence;
- every safe and strict signal changing the effective identity;
- Debug/Release, variant, all-architecture, and ABI separation;
- exact ADB selector correlation, one-target defaulting, and rejection of
  boolean or ambiguous target selection;
- an ordered `arm64-v8a,armeabi-v7a` response selecting `arm64-v8a`, plus a
  response with no supported ABI disabling caching;
- command timeouts, oversized output, missing executables, malformed versions,
  ambiguous Android targets, and strict offline constraints;
- no absolute paths, device IDs, raw environment values, or raw manual keys in
  insights and events;
- schema-1 insight compatibility and strict schema-2 validation;
- environment-first miss explanations and deterministic candidate ranking;
- changed post-build environment identity and concurrent lifecycle isolation.

The example static check verifies option parsing and callback shape. The native
iOS oracle runs build-only Simulator targets in this order:

1. Debug miss and upload;
2. Debug hit;
3. Release miss explained as build configuration change and upload;
4. Release hit.

When an Android emulator is available, the analogous oracle runs a targeted
debug build twice and an all-architecture or release build twice. Every oracle
also checks telemetry deltas, diagnostic privacy, and `doctor` health.

The complete repository format, lint, type, unit, package build, example static,
Expo export, tarball consumer, and available native checks must pass before the
milestone is committed and published as a stacked pull request.
