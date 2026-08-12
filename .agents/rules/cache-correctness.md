# Cache Correctness Rules

1. A cache hit is valid only when its platform, fingerprint, artifact type, and
   integrity metadata agree with the requested entry.
2. Never write directly to a final cache entry. Build a sibling staging entry,
   validate it, then publish it with an atomic rename.
3. Entries are immutable after publication. Metadata that changes over time
   belongs in a separate atomic record or append-only event log.
4. Coordinate writers with an atomic lock. Locks must include ownership and
   creation metadata and must have a safe stale-lock recovery path.
5. A process interruption may leave staging or lock data, but never a final
   entry that can be mistaken for complete.
6. Corrupt versioned entries must not be returned. Quarantine them when safe,
   log a concise reason, and continue as a cache miss.
7. Preserve compatibility with the documented legacy top-level `.apk` and
   `.app` entries until a major release explicitly removes it.
8. Treat filesystem, checksum, copy, and cleanup failures as non-fatal provider
   failures. Expo must be allowed to continue with a normal native build.
9. Tests must cover files and directories, partial entries, corrupt metadata,
   concurrent writers, stale locks, overwrite behavior, and legacy resolution.
