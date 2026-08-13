# Code Structure Rules

Read this file before adding a feature or moving production code.

## Module size

- Aim for 500 lines or fewer per production module.
- Production files have a hard limit of 800 lines. Split by responsibility
  before crossing it; never increase the automated limit to fit a feature.
- Entrypoints are stricter: `src/index.ts` stays below 450 lines, while
  `src/cli.ts` and `src/cli-bin.ts` stay below 100 lines.
- Test files should normally stay below 600 lines. Stateful integration suites
  may be larger, but the automated ceiling is 1,000 lines. Extract fixtures and
  split by behavior before reaching it.

Run `bun run architecture:check` after adding or moving modules.

## Dependency direction

Use this direction unless a documented integration boundary requires otherwise:

```text
entrypoints -> provider / CLI -> cache and LAN domains -> filesystem / codecs
```

- Entrypoints compose behavior; they do not own cache algorithms, protocol
  parsing, retention policy, or filesystem transactions.
- `src/cache/` owns local cache formats and operations. It must not import the
  provider adapter or CLI command handlers.
- `src/lan/` owns trusted transport, discovery, pairing, and wire transfer. It
  may call public cache operations, never provider lifecycle state.
- `src/cli/` owns argument parsing, presentation, and command orchestration.
- `src/provider/` owns Expo callback lifecycle, telemetry orchestration, and
  fail-open integration between cache and LAN domains.
- Cache doctor checks are the explicit exception allowed to inspect LAN state;
  they remain read-only and never contact a peer.

## File organization

- Preserve public imports with a small barrel when splitting an established
  module. Keep implementation in sibling modules or a same-named folder.
- Name files after one responsibility (`schema`, `storage`, `diff`, `http`,
  `arguments`), not generic buckets such as `utils` or `helpers`.
- Keep types beside the domain that owns them. Move a type to a shared module
  only after two independent modules genuinely depend on it.
- Avoid circular imports and deep imports across domains. Import another
  domain through its public module when one exists.
- Tests mirror feature boundaries. Shared setup belongs in a focused fixture,
  not copied across suites.

## Refactor safety

- Keep public exports and on-disk formats compatible unless the task explicitly
  authorizes a breaking change.
- A structure-only change must have focused tests proving behavior is unchanged,
  followed by the full validation suite.
- Design notes and brainstorming artifacts are never production inputs and
  must never be committed under `docs/superpowers/specs/`.
