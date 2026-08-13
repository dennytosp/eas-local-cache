# Architecture

`eas-local-cache` is organized around two runtime domains: the local cache and
the optional trusted LAN transport. Expo and the CLI are adapters around those
domains rather than places where storage or protocol logic lives.

```text
src/
├── index.ts                 Expo build-cache provider composition
├── provider/                Expo callback lifecycle and orchestration
├── cli.ts                   Stable CLI barrel
├── cli-bin.ts               Executable entrypoint
├── cli/                     Arguments, presentation, and command handlers
├── cache/                   Local cache domain
│   ├── insight/             Fingerprint evidence schema, storage, and diffing
│   └── toolchain/           Environment discovery by platform
└── lan/                     Authenticated HTTPS, pairing, discovery, and sync
```

## Boundaries

The dependency direction is:

```text
Expo / executable entrypoints
        ↓
provider and CLI adapters
        ↓
cache and LAN domain operations
        ↓
filesystem, integrity, archive, and codec primitives
```

The provider fails open: diagnostic, cache, cleanup, and LAN failures must not
invalidate a native build. Cache data and LAN input are treated as untrusted and
validated before use.

## Stable barrels

Large historical modules keep their existing import path as a small public
barrel where practical:

- `cache/insight.ts` exposes the `cache/insight/` modules.
- `cache/toolchain.ts` exposes the `cache/toolchain/` modules.
- `cli.ts` exposes argument parsing and command execution from `cli/`.

This allows internal structure to improve without forcing consumers or tests to
use implementation paths.

## Size guardrails

`bun run architecture:check` enforces the repository ceilings from
`.agents/rules/code-structure.md`. The limits are regression guards, not design
targets: new modules should generally be substantially smaller than the hard
maximum.

When a module approaches its ceiling, split along an existing responsibility
boundary. Do not create arbitrary numbered parts and do not increase the limit
to avoid the refactor.
