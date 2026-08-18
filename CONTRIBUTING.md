# Contributing

Dynobox is a pnpm monorepo. Published packages live under `packages/`.

## Requirements

- Node.js 22.12 or newer for monorepo development. Published packages may
  support an earlier Node.js 22 release according to their package engines.
- pnpm 10.33.0, as declared by the root `packageManager`.
- At least one supported local harness installed and authenticated when running
  real dynos: Claude Code via `claude`, Codex via `codex`, OpenCode via
  `opencode`, Pi via `pi`, Cursor CLI via `cursor-agent`, or Google Antigravity
  CLI 1.1.14 or newer via `agy`.

## Common Commands

Run from the repository root:

```bash
pnpm install --frozen-lockfile
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
node packages/cli/dist/bin.js --help
```

For local iteration, run the TypeScript entrypoint directly:

```bash
pnpm dynolocal --help
```

To exercise a real harness run with the compiled CLI without adding generated
files to the checkout, create the starter in a temporary directory:

```bash
repo_root=$PWD
smoke_dir=$(mktemp -d)
(
  cd "$smoke_dir"
  node "$repo_root/packages/cli/dist/bin.js" init
  node "$repo_root/packages/cli/dist/bin.js" run
)
rm -rf "$smoke_dir"
```

The starter defaults to Claude Code. Pass `--harness codex`,
`--harness opencode`, `--harness pi`, `--harness cursor`, or
`--harness antigravity` to `init` to use another authenticated harness. See
[`dynobox/examples`](https://github.com/dynobox/examples) for larger scenarios.

## Package Scripts

Package scripts should only build, typecheck, and test their own package. Use
root-level pnpm filters for dependency ordering instead of calling another
workspace package's script from inside a package script.
