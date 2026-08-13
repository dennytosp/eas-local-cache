# Explainable Cache and Telemetry Design

## Goal

Make local build-cache behavior understandable without changing which native
inputs Expo considers part of a build. A cache miss should report the strongest
available evidence, and `eas-local-cache stats` should report retained hit rate
and a conservative estimate of time saved. Diagnostics must remain local,
privacy-safe, bounded, and unable to fail an Expo build.

## Scope and compatibility

This milestone adds three capabilities:

- capture a sanitized snapshot of Expo's native fingerprint inputs;
- explain a miss by comparing the new snapshot with the closest compatible
  cached snapshot;
- record bounded resolve events for hit-rate and time-saved statistics.

The provider implements Expo's optional `calculateFingerprintHash` callback and
loads the app's own `@expo/fingerprint` package. It calls
`createFingerprintAsync(projectRoot, { silent: true })` with the same default
platform scope Expo CLI uses today. The returned hash must be identical to
Expo's default hash; this milestone does not add platform, toolchain, CPU, SDK,
or build-configuration inputs to the key. Toolchain-aware keying is a separate
milestone with an explicit key migration.

If the project-local fingerprint package cannot be loaded or fingerprinting
fails, the callback logs one concise warning and returns `null`, allowing Expo
to skip caching without interrupting the native build. Failure to persist
diagnostic metadata does not discard an otherwise valid fingerprint or cache
artifact.

## Fingerprint snapshots

The calculation callback keeps the latest in-memory sanitized snapshot keyed by
project root, platform, fingerprint hash, and a sanitized requested run profile.
Expo 57 calls this callback before resolution and again before upload. Therefore
the resolve callback, not fingerprint calculation, creates a separate pending
build context containing the miss wall-clock time and initial fingerprint hash.
The second calculation may refresh fingerprint evidence but must not overwrite
that miss time. Upload consumes a context only when its project, platform,
profile, and before/after-build fingerprint hashes match. A changed hash or two
ambiguous concurrent in-process builds disables timing correlation rather than
guessing; snapshot publication remains available for the upload hash.
Calculation snapshots and pending contexts are cleared on hit, provider error,
changed post-build hash, and upload completion so a long-lived host cannot grow
these maps without bound.

Upload publishes the matching snapshot as immutable `insight.json` inside the
entry staging directory before the entry's atomic rename. It writes a temporary
insight and renames it within staging. On serialization or write failure it
removes all partial insight files and continues publishing the artifact without
diagnostics. An already committed valid entry is never mutated to backfill an
insight. Existing entries without `insight.json` remain valid and usable.

An insight record contains:

- schema version, platform, entry ID, fingerprint hash, and capture time;
- the resolved `@expo/fingerprint` package version;
- a sanitized run profile;
- ordered fingerprint source descriptors containing source type, opaque
  comparator identity, duplicate occurrence, optional safe project-relative
  display path, nullable digest, and fixed internal evidence categories;
- an optional artifact-ready duration estimate and its measurement method.

Snapshots never contain source `contents`, `debugInfo`, absolute paths, raw Expo
configuration, raw fingerprint reasons or contents IDs, environment variables,
device identifiers, ports, application IDs, or binary paths. Comparator
identity follows Expo's source identity rules—`overrideHashKey ?? filePath` for
file/directory sources and `id` for contents—but only a SHA-256 label is stored.
Repeated comparator identities retain their occurrence order so duplicates are
matched one-to-one. A display path is retained only when it is a bounded safe
path relative to the project root; outside or arbitrary identities remain
opaque. Unknown reason strings map to the fixed `other` category and are never
stored or logged. Symlinked or malformed metadata is ignored.

The sanitizer accepts at most 10,000 sources, a 256-character display path, and
only fixed category tokens. The final serialized insight is capped at 1 MiB.
Exceeding a bound omits the entire insight and continues caching; sources are
not truncated because a partial snapshot could produce a misleading diff.
Readers open insights with `O_NOFOLLOW`, verify a regular file with `fstat`, and
reject files larger than 1 MiB before reading or parsing them.

The requested run profile is diagnostic metadata, not part of the M3 cache key.
Its schema normalizes iOS configuration to `Debug` when omitted, accepts a
string scheme or the fixed `default` sentinel, normalizes Android variant to
`debug`, and normalizes `allArch` to `false`. Unknown fields and non-string
scheme values are discarded. These are requested values, not claims about a
resolved scheme or device ABI. M4 will decide which normalized profile and
toolchain fields should affect cache identity.

## Miss explanation

The store exposes a detailed resolve outcome while retaining the existing
path-or-null adapter contract. A direct store outcome always takes precedence
over fingerprint inference. Direct reasons include corrupt entry quarantined,
writer lock busy, unsafe legacy path, and no matching entry.

For an ordinary no-entry miss, the provider compares the current snapshot with
the closest prior insight for the same platform and sanitized run profile.
Sources are matched by type, opaque comparator identity, and duplicate
occurrence, preserving Expo's add/remove/change semantics without persisting
raw identities. The candidate with the fewest added, removed, or changed
sources wins; ties use newest last access, then newest creation time, then entry
ID ascending so output is deterministic. An engine-version mismatch or a
missing compatible snapshot produces an explicit generic explanation rather
than a guess.

Diff evidence is grouped into five categories:

1. Expo configuration or config plugins changed;
2. native dependencies or autolinking changed;
3. native project inputs such as Podfile or Gradle files changed;
4. project metadata or patches changed;
5. other native fingerprint inputs changed.

The log displays at most three categories, sorted by affected-source count
descending and then the category priority above, and includes each displayed
count.

Reason labels from `@expo/fingerprint` are treated as provenance strings, not a
stable enum. The provider says "possible cause" unless the changed source
directly identifies a specific file. Null or coarse generated-native sources
must not be described as a definite Podfile or Gradle change. Logs use a short
fingerprint and never print full snapshots.

## Event telemetry

Each resolve callback that reaches the provider is written as one immutable
JSON event below
`v1/events/YYYY-MM-DD/`. Events use a timestamp plus random identifier, are
created with mode `0600`, and become visible through a same-filesystem atomic
rename. Readers reject symlinks and malformed records. Independent files avoid
lost updates when multiple Expo processes build concurrently. Day directories
and record timestamps use UTC, and readers verify that they agree. Readers walk
only owned day and event filename patterns, use `O_NOFOLLOW` plus `fstat`, and
reject non-regular or larger-than-16-KiB event files before reading them.

An event contains the schema version, timestamp, platform, entry ID, outcome
(`hit`, `miss`, or `error`), lookup duration, explanation code, and optional
estimated time saved. It does not contain a raw fingerprint or project/runtime
secrets. Event writes fail open.

Telemetry is retained for a fixed 90 days with a hard cap of 10,000 events. Each
writer takes a short telemetry lock, removes expired events and prunes to at
most 9,999 retained events oldest-first, then publishes the new event while
holding that lock. If it cannot acquire the lock within the short event budget,
it skips telemetry rather than exceeding the cap or delaying the build. This
path runs independently of `autoPrune`, so a hit-only workload remains bounded.
Manual `prune` uses the same lock.

`CachePaths`, inventory, and stats report event count and bytes separately.
Prune dry-run and results expose telemetry candidates and removals separately
from entry or auxiliary candidates. Event bytes are operational metadata with
their own bounds: they are not included in artifact `remainingBytes` or
`maxSize` satisfaction and do not cause valid native artifacts to be evicted.

`stats` reports:

- recorded hits, misses, and errors in the retained window;
- hit rate as `hits / (hits + misses)`, or `null` when no decisions exist;
- exact accumulated lookup time;
- estimated time saved and the number of hits without a usable estimate;
- telemetry window start/end and event count.

The command labels these values as retained local observations rather than
lifetime totals.

## Time-saved estimate

Expo invokes upload after build and may do so after install or launch, so the
elapsed time from miss resolution to upload is not called build time and is
never used as the fallback estimate.

For a newly built artifact, the provider finds the newest safe modification
time of the APK or regular files inside the app directory using `lstat` without
following symlinks. It accepts `artifactMtime - missStartedAt` only when the
duration is non-negative and at most six hours and the timestamp is no later
than the upload wall-clock time plus a two-second filesystem-clock tolerance.
The insight records this as the `artifact-mtime-v1` estimate. Stale, future,
incomplete, or unsafe timestamps produce no estimate.

Lookup duration uses a monotonic clock. Wall time is used only for event
timestamps and comparison with filesystem modification times.

On a later hit of the exact entry and compatible run profile, estimated time
saved is `max(0, artifactReadyDuration - lookupDuration)`. Missing estimates
remain unknown; no synthetic value is invented. Upload/copy duration may be
measured separately but is not time saved.

## Cleanup and diagnostics

Entry deletion naturally removes its co-located insight. Doctor validates an
insight when present but does not mark an otherwise valid pre-M3 entry unhealthy
when it is absent. Invalid insight and event files are reported as diagnostic
issues and ignored by statistics; `prune` may remove only files proven to be
inside library-owned insight/event paths.

Event retention runs under its dedicated short telemetry lock. Entry locks and
access leases continue to protect artifacts; telemetry cleanup never needs an
entry lock because events are immutable and do not affect resolution.

## Example verification

The example adds a dynamic Expo config layer that conditionally sets
`extra.easLocalCacheTestSalt` from `EAS_LOCAL_CACHE_TEST_SALT`. The field is
omitted when unset, and using a salt leaves no native or tracked-file mutation.
Expo's evaluated config is a real fingerprint source.

Native verification generates two non-secret, unpredictable per-run salt
values. The tokens are not logged or persisted in insight/event metadata, then
four builds run on the same target:

1. salt A: miss, native build, upload;
2. salt A again: hit;
3. salt B: miss explaining that Expo configuration changed, then upload;
4. salt B again: hit.

The test asserts two hit and two miss event deltas, not absolute counters, and
finishes with a healthy `doctor` result. Random per-run values keep the oracle
repeatable when older test entries exist. iOS runs on one simulator. Android
uses the same oracle when an emulator is available.

## Testing

Deterministic unit and process tests cover:

- project-local fingerprint loading, hash parity, fail-open behavior, Expo's
  two-calculation lifecycle, changed post-build hashes, and ambiguous concurrent
  pending contexts;
- snapshot sanitization and hard bounds, stable duplicate occurrences,
  nullable digests, unknown reason/identity privacy, engine-version mismatch,
  oversized read rejection, atomic insight publication failure, and absence of
  raw contents or paths;
- diff grouping, direct-reason precedence, closest-candidate selection, and
  generic explanations when evidence is insufficient;
- hit/miss/error events, concurrent subprocess writers, malformed and symlinked
  or oversized events, deterministic clocks and UTC buckets, retention under
  hit-only and auto-prune-disabled workloads, the strict cap, and CLI JSON
  purity;
- valid, stale, and future artifact timestamps; exact lookup duration; and hits
  without a time-saved estimate;
- backward compatibility for entries without insights and unchanged cache keys;
- the example's static checks, Metro export, and salt A/A/B/B native flow.

All provider-side diagnostic failures degrade to a warning and preserve the
native build result.
