# dynobox

Cross-harness testing for multi-step agent flows.

This package is a placeholder. Dynobox is under active development.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current status

The CLI currently builds and runs as a real TypeScript package, but its runtime behavior is still the placeholder message while Milestone 1 is in progress.

Running the CLI currently prints the placeholder message and exits with code `1`.

## Local development

Run from the repository root:

```bash
pnpm --filter dynobox test
pnpm --filter dynobox typecheck
pnpm --filter dynobox build
node packages/cli/dist/bin.js
```

Run from `packages/cli`:

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/bin.js
```

## Run without building

From the repository root:

```bash
pnpm tsx packages/cli/src/bin.ts
```

From `packages/cli`:

```bash
pnpm tsx src/bin.ts
```
