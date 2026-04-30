# dynobox

CLI for authoring and running Dynobox scenario configs.

Dynobox is under active development and not ready for external use.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current status

The CLI currently loads an explicit config path, resolves the config module's default export, compiles it with `@dynobox/sdk`, and runs local jobs with `@dynobox/runner-local`.

Local execution currently supports harness tool assertions. HTTP capture and HTTP assertion evaluation are not wired in yet.

Example:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts
```

Expected output shape:

```text
dynobox run

config: examples/local-observability/dynobox.config.ts
jobs: 1

[1/1] inspect package scripts claude-code iter 1 PASS

Assertions:
PASS tool.called(shell)
PASS tool.called(shell, includes: package.json)
```

## Local development

Run from the repository root:

```bash
pnpm --filter dynobox test
pnpm --filter dynobox typecheck
pnpm --filter dynobox... build
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
