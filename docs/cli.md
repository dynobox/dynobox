# CLI Reference

The public CLI package is `dynobox`. Install with:

```bash
npm install -g dynobox
```

When working from a repository checkout, run the built binary with
`node packages/cli/dist/bin.js`.

## Commands

### `dynobox run [path]`

Discover and run dyno files.

- _no path_ — discover under the current working directory.
- _directory_ — discover recursively under the given directory.
- _file_ — run that one file. Any extension is accepted for an explicit file
  path, so existing `dynobox.config.ts` files keep working during migration.

Discovery globs `**/*.dyno.{mjs,js,ts,mts,yaml,yml}` and skips `node_modules`,
`dist`, `build`, `coverage`, `.git`, `.dynobox`, `.next`, and `.cache` by
default. `.cjs`/`.cts` configs aren't supported because `@dynobox/sdk` ships
as ESM-only.

```bash
dynobox run                          # discover under .
dynobox run examples                 # discover under examples/
dynobox run my-skill.dyno.yaml       # run a single YAML file
dynobox run path/to/legacy/config.ts # explicit file still works
```

A failure in one discovered file does not abort the rest of the run — each bad
file produces its own `config:` error block on stderr; valid files still
execute. The process exits non-zero if any file failed to load or any job
failed.

### `dynobox init`

Scaffold a starter dyno under `./dynobox/` so a fresh project can go from `npm
install -g dynobox` to a passing run in two commands.

```bash
dynobox init             # writes dynobox/example.dyno.mjs
dynobox init --yaml      # writes dynobox/example.dyno.yaml instead
dynobox init --harness codex
dynobox init --force     # overwrite an existing starter
```

## Options For `run`

```text
--harness <id>             Override config harnesses; repeat or comma-separate
                           for multiple harnesses.
--permission-mode <mode>   Override harness permission mode: default or
                           dangerous.
--quiet                    Print compact CI-friendly output.
--verbose                  Expand scenario details even when passing.
--debug                    Include debug paths and artifacts.
```

Harness IDs are `claude-code` and `codex`.

Examples:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
dynobox run --harness codex --permission-mode dangerous
```

## Output Modes

- _default_ — run header, job status, assertion results for failures or
  expanded jobs, and a summary. Passing jobs collapse to one line.
- `--quiet` — CI-friendly compact progress and failure information.
- `--verbose` — expand scenario details even when jobs pass.
- `--debug` — include temporary work-directory paths and write harness debug
  logs inside each job's work directory when data is available:
  - `dynobox-transcript.log` — extracted harness transcript.
  - `dynobox-chat-history.jsonl` — raw harness stdout / JSONL chat stream.
  - `dynobox-tool-events.json` — normalized tool events used by assertions.
  - `dynobox-stderr.log` — raw harness stderr, when non-empty.

When stdout is an interactive terminal and live output is enabled, Dynobox
streams phase progress and harness tool events as they happen. In
non-interactive output, quiet mode, or incompatible terminals, it runs jobs to
completion and renders static output.

## Exit Behavior

The CLI uses exit code `1` for:

- No subcommand supplied.
- Config load, parse, validation, or flag errors (including "no dynos found").
- At least one completed job failed.

A successful run exits with `0`.

## Harness Requirements

The CLI registers both real harnesses by default:

- `claude-code` invokes `claude -p --verbose --output-format stream-json
  --include-hook-events ...`.
- `codex` invokes `codex exec --json --color never --skip-git-repo-check ...`.

Make sure the harness executable you select is installed, authenticated, and
available on `PATH`.

Dynobox defaults to each harness's normal permission behavior. Use
`--permission-mode dangerous` only for trusted local evals that need full
access or non-interactive approval bypasses.

Dangerous mode maps to harness-specific flags:

- `claude-code` — adds `--permission-mode bypassPermissions`.
- `codex` — adds `--sandbox danger-full-access -c approval_policy="never"`.

## Local Development Commands

From the repository root:

```bash
pnpm --filter dynobox test
pnpm --filter dynobox typecheck
pnpm --filter dynobox... build
```

Run from built output:

```bash
node packages/cli/dist/bin.js run examples/local-observability
```

Run from source:

```bash
pnpm tsx packages/cli/src/bin.ts run examples/local-observability
```
