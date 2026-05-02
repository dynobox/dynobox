# dynobox

CLI for authoring and running Dynobox scenario configs.

Dynobox is under active development and not ready for external use.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current status

The CLI currently loads an explicit config path, resolves the config module's default export, compiles it with `@dynobox/sdk`, and runs local jobs with `@dynobox/runner-local`.

Local execution currently supports harness tool assertions. HTTP capture and HTTP assertion evaluation are not wired in yet.

When stdout is an interactive terminal, `dynobox run` streams phase progress while jobs run and shows live harness tool events as they are observed.

Example:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts
```

Expected output shape:

```text
  dynobox  0.0.3

  config   examples/local-observability/dynobox.config.ts
  plan     1 scenario · 1 harness · 1 iteration                   1 job

  ✓  inspect package scripts                       claude-code  iter 1
     ✓ setup      1 command                                          0.1s
     ✓ harness    ran prompt 2 tools                                 8.2s
     ✓ assertions 2 of 2 passed                                      0.0s
        ✓ tool.called(shell)
        ✓ tool.called(shell, includes: package.json)

  ──────────────────────────────────────────────────────────────────────
  1 passed   0 failed                                             8.3s
```

Run output modes:

- `--quiet`: compact dots-and-failures output for CI.
- `--verbose`: expand scenario details even when they pass.
- `--debug`: include work directory and artifact paths.

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
