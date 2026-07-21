# Contributing

Dynobox is a pnpm monorepo. Published packages live under `packages/`.

## Requirements

- Node.js compatible with the package engines.
- pnpm 10.33.0, as declared by the root `packageManager`.
- At least one supported local harness installed and authenticated when running
  real dynos: Claude Code via `claude`, Codex via `codex`, or OpenCode via
  `opencode`.

## Common Commands

Run from the repository root:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm validate
```

`validate` runs Prettier and ESLint in check-only mode.

Package-scoped examples:

```bash
pnpm --filter dynobox test
pnpm --filter @dynobox/sdk test
pnpm --filter dynobox... build
```

Use pnpm's workspace graph from the repo root when a package needs its
dependencies built first, for example `pnpm --filter dynobox... build`.

## Running The CLI From A Checkout

Build first, then run the compiled CLI:

```bash
pnpm --filter dynobox... build
node packages/cli/dist/bin.js run examples/local-observability
```

For local iteration, run the TypeScript entrypoint directly:

```bash
pnpm dynolocal run examples/local-observability
```

## Package Scripts

Package scripts should only build, typecheck, and test their own package. Use
root-level pnpm filters for dependency ordering instead of calling another
workspace package's script from inside a package script.

## Examples

Examples are user-facing only. Do not use files in `examples/` as test fixtures
or production code inputs.
