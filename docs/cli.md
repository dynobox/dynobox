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

Discovery globs `**/*.dyno.{mjs,js,ts,mts,yaml,yml}` and skips hidden entries,
`node_modules`, `dist`, `build`, `coverage`, `.git`, `.dynobox`, `.next`, and
`.cache` by default. Passing a hidden directory explicitly, such as
`.agents/skills`, searches inside that root but still skips hidden entries below
it. `.cjs`/`.cts` configs aren't supported because `@dynobox/sdk` ships as
ESM-only.

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
--scenario <pattern>       Run only scenarios whose name or id matches;
                           repeat or comma-separate for multiple patterns.
--quiet                    Print compact CI-friendly output.
--verbose                  Expand scenario details even when passing.
--debug                    Include debug paths and artifacts.
--reporter <fmt>           Output reporter format: text or json.
```

Harness IDs are `claude-code` and `codex`.

Examples:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
dynobox run --harness codex --permission-mode dangerous
dynobox run --scenario "release*"
dynobox run --scenario "lint*,deploy package"
dynobox run --reporter json
```

Scenario filters match the compiled scenario name or id. Patterns support `*`
for any number of characters and `?` for one character. If no scenarios match,
the run exits with the config-error exit code.

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
- `--reporter json` — emit newline-delimited JSON on stdout instead of the
  text renderer. Dynobox writes one job object per completed job, then one
  summary object. The JSON reporter always uses the static run path, even in
  interactive terminals, so stdout remains machine-readable.

See [CI Integration](./ci.md) for a GitHub Actions recipe that runs a harness
matrix, uploads JSON reports, and summarizes the final summary record.

If a harness reports that a tool action was blocked by permissions or sandbox
policy, Dynobox prints a permission warning and includes it in JSON output. This
is advisory context only: warnings do not change job status, assertion results,
or exit codes. Use `--permission-mode dangerous` only for trusted evals that
intentionally need that access.

When stdout is an interactive terminal and live output is enabled, Dynobox
streams phase progress and harness tool events as they happen. In
non-interactive output, quiet mode, or incompatible terminals, it runs jobs to
completion and renders static output.

### JSON Reporter

Every JSON reporter object includes `"schema": "dynobox.report.v1"` and a
`type` field.

Job records include:

- `jobId`
- `scenario.id` and `scenario.name`
- `harness.id`, with `model` and `permissionMode` when configured
- `iteration`, using a 1-based number
- `status` and `passed`
- `timing`
- `diagnostics`
- `warnings`, with `kind`, `message`, and optional blocked tool metadata
- `artifacts`, plus `debugLogPaths` when `--debug` produced logs
- `setup.commands`
- `harnessOutput.exitCode` and `harnessOutput.durationMs` when the harness ran
- `observations.toolEventCount` and `observations.httpEventCount`
- `assertions`, with `assertionId`, `kind`, `passed`, and `message`

The final summary record includes:

- `status`
- `totals.jobs`, `totals.passed`, `totals.failed`, `totals.configErrors`, and
  `totals.warnings`, and `totals.durationMs`
- `plan.scenarios`, `plan.harnesses`, and `plan.iterations`
- `failedJobs`
- `warningJobs`

Example:

```bash
dynobox run --reporter json examples/local-observability
```

In CI, redirect stdout to an artifact file:

```bash
dynobox run --reporter json dynobox > dynobox-report.ndjson
```

## Exit Behavior

The CLI uses exit code `1` for:

- No subcommand supplied.
- Config load, parse, validation, or flag errors (including "no dynos found").
- At least one completed job failed.

A successful run exits with `0`.

## Harness Requirements

The CLI registers both real harnesses by default:

- `claude-code` invokes Claude Code with stream JSON output and hook events.
- `codex` invokes Codex with JSON output, no color, and the git-repo check
  skipped.

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
