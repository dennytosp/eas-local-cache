# Explainable Cache Implementation Plan

## Delivery target

Implement roadmap milestone 3 on `feat/explain-cache-miss` without changing
Expo's default fingerprint hash or weakening M1/M2 cache correctness.

## Work packages

1. Fingerprint and insight metadata

   - Normalize requested run profiles.
   - Load project-local `@expo/fingerprint` and preserve Expo hash parity.
   - Sanitize and bound source snapshots without raw contents, reasons, IDs, or
     absolute paths.
   - Atomically write and safely read optional entry insights.
   - Diff snapshots, group evidence, and select the closest compatible entry.

2. Resolve events and timing

   - Store one bounded immutable event per resolve under UTC day buckets.
   - Enforce 90-day and 10,000-event limits under a dedicated lock.
   - Summarize retained hit/miss/error rates and conservative time saved.
   - Calculate artifact-ready estimates from validated file mtimes.

3. Provider and store integration

   - Add a detailed resolve result while retaining the path-or-null API.
   - Track calculation snapshots separately from miss build contexts.
   - Publish insights only with new immutable entries.
   - Log direct miss reasons before heuristic evidence.
   - Record telemetry without making a build depend on diagnostics.

4. Inspector integration

   - Add event paths, bytes, counts, and issues to inventory and doctor.
   - Prune telemetry separately from artifact capacity decisions.
   - Replace placeholder CLI hit-rate/time-saved fields with retained summaries.

5. Example verification

   - Add a conditional Expo config salt.
   - Verify provider fingerprint callback and config parity statically.
   - Document and automate the repeatable A/A/B/B native oracle.

6. Verification and delivery
   - Run formatting, lint, typecheck, all Bun tests, package build, example
     checks, export smoke test, tarball consumer test, and iOS native A/A/B/B.
   - Request independent read-only code review and address findings.
   - Commit focused implementation changes, push the stacked branch, create the
     pull request, and monitor CI to green before starting milestone 4.

## Compatibility rules

- Entries without `insight.json` stay valid.
- Diagnostic metadata never changes cache validity or cache identity.
- Telemetry and insight failures fail open.
- Raw fingerprints appear only in immutable manifest identity, as before; event
  records use entry IDs and logs use short hashes.
- Event bytes are bounded operational metadata and never evict artifacts for
  `maxSize` compliance.
