# Cache Inspector and Automatic Cleanup Design

## Goal

Keep the local Expo build cache observable and bounded without making cache
maintenance capable of breaking a native build. The same inventory and policy
engine powers both the provider's automatic cleanup and the CLI commands.

## Provider options

The provider accepts these custom options:

```json
{
  "maxSize": "20GB",
  "maxEntries": 50,
  "retentionDays": 14,
  "autoPrune": true
}
```

The values above are the zero-config defaults. A `null` limit disables that
single constraint. Invalid options disable destructive automatic cleanup for
that invocation and produce a warning rather than failing the Expo build.

## Mutable metadata

Published entry manifests stay immutable. Last-access time and a short lease
are stored atomically under `v1/access/<entryId>.json`. A missing or malformed
access record falls back to the manifest creation time. The lease prevents an
artifact from being removed immediately after Expo receives its path.

The normalized policy last used by the provider is written atomically below
`v1/state/policy.json`, allowing the CLI to use the same defaults and project
configuration without evaluating the Expo application config.

## Inventory and cleanup

Inventory never follows symlinked provider, platform, entry, or maintenance
paths. It reports entry, quarantine, staging, trash, metadata, and compatible
legacy usage separately.

Cleanup uses one maintenance lock and non-blocking per-entry locks. It removes
abandoned trash, expired maintenance data, and invalid entries before
least-recently-used entries until both count and size limits are satisfied. The
size limit covers artifact-bearing managed data: valid and invalid entries,
staging, quarantine, and trash. Operational metadata and legacy flat entries are
reported but never deleted automatically. The entry just uploaded, leased
entries, and entries with active locks are skipped. Entry removal first renames
into library-owned trash, making disappearance atomic, then deletes the
tombstone.

Automatic cleanup runs only after upload has published and released its writer
lock. Cleanup failures are warnings and do not change the successful upload
result. A single protected artifact may temporarily exceed a soft cap.

## CLI

The package exposes these commands:

```text
eas-local-cache stats [--project-root PATH] [--json]
eas-local-cache list [--project-root PATH] [--platform ios|android] [--json]
eas-local-cache doctor [--project-root PATH] [--json]
eas-local-cache prune [--project-root PATH] [--dry-run] [policy overrides]
```

`stats` reports exact capacity data. Hit rate and estimated time saved remain
unavailable until the explainable-cache milestone records reliable resolve and
build events. `doctor` is read-only and performs full manifest and integrity
checks. `prune --dry-run` uses the real eviction planner without filesystem
mutation. JSON is written only to stdout; diagnostics use stderr.

Exit status is `0` for success, `1` for diagnosed or partially resolved cache
issues, and `2` for invalid CLI usage or policy values.

## Verification

Tests use injected timestamps and cover option parsing, atomic access metadata,
deterministic TTL/LRU planning, combined size and count limits, leases, active
locks, symlink boundaries, abandoned maintenance data, dry-run behavior,
doctor integrity findings, CLI output and exit status, and provider auto-prune.
The Expo example must still demonstrate an unchanged miss-to-hit native round
trip under the default policy.
