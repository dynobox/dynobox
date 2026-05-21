# CLI Reference

The public CLI package is `dynobox`:

```bash
npm install -g dynobox
```

From a repository checkout, build first and run
`node packages/cli/dist/bin.js`.

## Commands

### `dynobox init`

Create a starter dyno under `./dynobox/`.

```bash
dynobox init
dynobox init --yaml
dynobox init --harness codex
dynobox init --force
```

`dynobox init` writes `dynobox/example.dyno.mjs` by default. With `--yaml`, it
writes `dynobox/example.dyno.yaml`. Existing starter files are not overwritten
unless `--force` is passed.

### `dynobox run [path]`

Discover and run dyno files.

```bash
dynobox run
dynobox run examples
dynobox run my-skill.dyno.yaml
dynobox run dynobox.config.ts
```

Path behavior:

- No path: discover under the current working directory.
- Directory path: discover recursively under that directory.
- File path: run that one loadable Dynobox config file.

Directory discovery matches `**/*.dyno.{mjs,js,ts,mts,yaml,yml}`. It skips
hidden entries, `node_modules`, `dist`, `build`, `coverage`, `.git`,
`.dynobox`, `.next`, and `.cache`.

Explicit file paths do not need to match the `*.dyno.*` naming pattern. YAML
files are parsed as YAML, and JavaScript or TypeScript files such as `.mjs`,
`.js`, `.ts`, and `.mts` are imported through the CLI loader. `.cjs` and `.cts`
configs are not supported because `@dynobox/sdk` is ESM-only.

A load error in one discovered file does not stop other files from running.
Each bad file prints a `config:` error block on stderr, and the process exits
non-zero if any file failed to load or any job failed.

## Run Options

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
the run exits with code `1`.

## Output Modes

Default output prints the run header, job status, assertion details for failed
or expanded jobs, and a final summary. Passing jobs collapse to one line.

`--quiet` prints compact CI-friendly progress and failure information.

`--verbose` expands scenario details even when jobs pass.

`--debug` includes temporary work-directory paths and writes debug logs inside
each job's work directory when data is available. Debug logs can include:

- `dynobox-transcript.log`
- `dynobox-chat-history.jsonl`
- `dynobox-tool-events.json`
- `dynobox-stderr.log`

`--reporter json` emits newline-delimited JSON on stdout instead of text.
Dynobox writes one job object per completed job, then one summary object. The
JSON reporter always uses static output so stdout remains machine-readable.

When stdout is an interactive terminal and live output is enabled, Dynobox
streams phase progress and harness tool events as they happen. In
non-interactive output, quiet mode, or incompatible terminals, it renders static
output after jobs complete.

## JSON Reporter

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
- `warnings`
- `artifacts`
- `debugLogPaths` when `--debug` produced logs
- `setup.commands`
- `harnessOutput.exitCode` and `harnessOutput.durationMs` when the harness ran
- `observations.toolEventCount` and `observations.httpEventCount`
- `assertions`, with `assertionId`, `kind`, `passed`, and `message`

The summary record includes:

- `status`
- `totals.jobs`, `totals.passed`, `totals.failed`, `totals.configErrors`,
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

## Exit Codes

Dynobox exits with `0` when all loaded jobs pass.

Dynobox exits with `1` for:

- No subcommand supplied.
- Config load, parse, validation, or flag errors.
- No dynos found for a directory target.
- At least one completed job failed.

## Harness Requirements

The CLI registers both real harnesses by default:

- `claude-code` invokes Claude Code with stream JSON output and hook events.
- `codex` invokes Codex with JSON output, no color, and the git-repo check
  skipped.

Make sure the selected harness executable is installed, authenticated, and
available on `PATH`.

Dynobox uses each harness's normal permission behavior by default. Use
`--permission-mode dangerous` only for trusted local evals that intentionally
need full access or non-interactive approval bypasses.

Dangerous mode maps to harness-specific flags:

- `claude-code`: adds `--permission-mode bypassPermissions`.
- `codex`: adds `--sandbox danger-full-access -c approval_policy="never"`.

Permission warnings are advisory. They explain when a harness blocked a tool
action, but they do not change job status, assertion results, or exit codes.

## Development Checkout

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
