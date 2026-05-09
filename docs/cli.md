# CLI Reference

The public CLI package is `dynobox`. In this repository, run it from built output with `node packages/cli/dist/bin.js` or from source with `pnpm tsx packages/cli/src/bin.ts`.

## Commands

```bash
dynobox run <config> [options]
```

`<config>` is the path to a TypeScript Dynobox config module. The module must default-export a dyno created with `defineDyno` or a compatible config object.

## Options

```text
--harness <id>   Override config harnesses for this run; repeat or comma-separate for multiple harnesses.
--quiet          Print compact CI-friendly output.
--verbose        Expand scenario details even when passing.
--debug          Include debug paths and artifacts.
```

Harness IDs are `claude-code` and `codex`.

Examples:

```bash
dynobox run dynobox.config.ts --harness claude-code
dynobox run dynobox.config.ts --harness codex
dynobox run dynobox.config.ts --harness claude-code,codex
dynobox run dynobox.config.ts --harness claude-code --harness codex
```

## Output Modes

Default mode shows a run header, job status, assertion results for failures or expanded jobs, and a summary.

`--quiet` is intended for CI. It prints compact progress and failure information.

`--verbose` expands scenario details even when jobs pass.

`--debug` includes temporary work-directory paths and writes harness transcripts to `dynobox-transcript.log` inside each job work directory when transcript text is available.

When stdout is an interactive terminal and live output is enabled, Dynobox streams phase progress and harness tool events as they happen. In non-interactive output, quiet mode, or incompatible terminals, it runs jobs to completion and renders static output.

## Exit Behavior

The current CLI uses exit code `1` for:

- No subcommand supplied.
- Config load, parse, validation, or flag errors.
- At least one completed job failed.

A successful run exits with `0`.

## Harness Requirements

The CLI registers both real harnesses by default:

- `claude-code` invokes `claude -p --verbose --output-format stream-json --include-hook-events ...`.
- `codex` invokes `codex exec --json --color never --skip-git-repo-check --sandbox danger-full-access -c approval_policy="never" ...`.

Make sure the harness executable you select is installed, authenticated, and available on `PATH`.

## Local Development Commands

From the repository root:

```bash
pnpm --filter dynobox test
pnpm --filter dynobox typecheck
pnpm --filter dynobox... build
```

Run from built output:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness claude-code
```

Run from source:

```bash
pnpm tsx packages/cli/src/bin.ts run examples/local-observability/dynobox.config.ts --harness claude-code
```
