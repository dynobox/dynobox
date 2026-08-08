# CLI Reference

The public CLI package is `dynobox`:

```bash
npm install -g dynobox
```

## Commands

### Global Options

```bash
dynobox --help
dynobox --version
dynobox -V
```

Running `dynobox` with no subcommand prints the starter banner and exits `0`.

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
unless `--force` is passed. `--harness` accepts the same harness IDs as
`dynobox run`; invalid harness IDs fail before writing a starter file.

### `dynobox login`

Save a Dynobox CLI token for authenticated commands.

```bash
dynobox login
```

The command prints a link to [dash.dynobox.xyz](https://dash.dynobox.xyz), where
you can create a short-lived CLI token. Paste that token into the prompt and the
CLI stores it in `~/.dynobox/config.json`.

CLI tokens expire after 24 hours. When a token expires, run `dynobox login`
again to create and save a new one.

Environment overrides:

- `DYNOBOX_TOKEN`: use a token from the environment instead of local config.
- `DYNOBOX_API_URL`: development override for the Dynobox API. Commands still
  require and send Dynobox authentication.
- `DYNOBOX_DASHBOARD_URL`: point `dynobox login` at a different dashboard URL.
- `DYNOBOX_UPLOAD_URL`: post `--save-run` payloads to an exact custom URL.

### `dynobox whoami`

Verify the saved Dynobox CLI identity.

```bash
dynobox whoami
```

The command checks the saved token against the Dynobox API and prints the
authenticated email when the token includes one. Invalid, revoked, expired, or
unreachable tokens return a non-zero exit code with a specific error message.

### `dynobox logout`

Remove the saved Dynobox CLI token.

```bash
dynobox logout
```

The command deletes `~/.dynobox/config.json` when it exists. If `DYNOBOX_TOKEN`
is still set in the environment, the CLI notes that authenticated commands will
continue to use that environment token.

### `dynobox run [path]`

Discover and run dyno files.

```bash
dynobox run
dynobox run .agents/skills/
dynobox run my-skill.dyno.yaml
dynobox run dynobox.config.ts
dynobox run --config dyno.config.json
```

Path behavior:

- No path: discover under the current working directory.
- Directory path: discover recursively under that directory.
- File path: run that one loadable Dynobox config file.

Directory discovery matches `**/*.dyno.{mjs,js,ts,mts,yaml,yml}`. It skips dot
directories by default, but explicitly includes `.agents` and `.claude` skill
directories. If you pass a hidden directory as `[path]`, Dynobox searches that
directory. Discovery also skips `node_modules`, `dist`, `build`, `coverage`,
`.git`, `.dynobox`, `.next`, and `.cache`.

Directory discovery also reads a `dyno.config.json` from the current working
directory — the directory you run the command in, not the `[path]` argument and
with no upward walk. For now the config is JSON-only and supports
`ignoredDirectories`:

```json
{
  "ignoredDirectories": ["generated", "vendor/examples"]
}
```

Each ignored directory is treated as a directory path relative to the
`dyno.config.json` file and skipped recursively. Run commands from your project
root so its `dyno.config.json` applies, or pass `--config <path>` to use a
specific config file from anywhere. Run with `--verbose` (or `--debug`) to print
which `dyno.config.json` applied.

Explicit file paths do not need to match the `*.dyno.*` naming pattern. YAML
files are parsed as YAML, and JavaScript or TypeScript files such as `.mjs`,
`.js`, `.ts`, and `.mts` are imported through the CLI loader. `.cjs` and `.cts`
configs are not supported because `@dynobox/sdk` is ESM-only.

Only run dynos you trust. JavaScript and TypeScript configs are imported, and
setup and verification commands execute on your machine. Temporary work
directories separate job files, but they are not security sandboxes; processes
can access the host according to their permissions.

A load error in one discovered file does not stop other files from running.
Each bad file prints a `config:` error block on stderr, and the process exits
non-zero if any file failed to load or any job failed.

### `dynobox discover [path]`

Print the dyno files that `dynobox run [path]` would load, one path per line,
without loading configs or running harnesses.

```bash
dynobox discover
dynobox discover dynobox
dynobox discover my-skill.dyno.yaml
dynobox discover --config dyno.config.json
```

`dynobox discover` uses the same path behavior and directory discovery rules as
`dynobox run`: no path discovers dynos under the current directory, a directory
discovers all matching `*.dyno.*` files below it, and a file path prints that one
loadable config path.

### `dynobox validate [path]`

Load and validate dyno files without running any harnesses.

```bash
dynobox validate
dynobox validate dynobox/
dynobox validate out.dyno.ts
dynobox validate --reporter json out.dyno.ts
```

`dynobox validate` uses the same path behavior and directory discovery rules as
`dynobox run`: no path validates discovered dynos under the current directory, a
directory validates all discovered `*.dyno.*` files below it, and a file path
validates that one loadable config file.

Validation loads JavaScript and TypeScript configs through the CLI loader,
parses YAML dynos, unwraps the config module, and compiles it through the SDK IR
compiler. It exits `0` when every config is valid and `1` when discovery,
loading, parsing, schema validation, or semantic compilation fails.

Default output prints a compact summary on stdout and config errors on stderr.
`--reporter json` emits newline-delimited JSON on stdout with one file record per
validated config and a final summary record.

## Run Options

```text
--harness <id>             Select harnesses; repeat or comma-separate for
                           multiple harnesses. Matching config metadata is
                           preserved.
--model <name>             Override selected harness models by position; repeat
                           or comma-separate for multiple harnesses.
--permission-mode <mode>   Override harness permission mode: default or
                           dangerous.
--scenario <pattern>       Run only scenarios whose name or id matches;
                           repeat or comma-separate for multiple patterns.
--iterations <count>       Run each selected scenario/harness pair this many
                           times. Defaults to 1.
--quiet                    Print compact CI-friendly output.
--verbose                  Expand every job with phase and assertion details.
--debug                    Include verbose details plus work dirs, artifact
                           paths, and debug logs.
--reporter <fmt>           Output reporter format: text or json.
--config <path>            Use a specific dyno.config.json file.
--save-run                 Upload a compact run summary to the dashboard
                           (requires a token; see Saving Runs below).
```

Harness IDs are `claude-code`, `codex`, and `opencode`.

Examples:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness opencode
dynobox run --harness claude-code,codex,opencode
dynobox run --harness codex --model gpt-5.5
dynobox run --harness opencode --model openai/gpt-5.5
dynobox run --harness claude-code,codex --model sonnet,gpt-5.5
dynobox run --harness codex --permission-mode dangerous
dynobox run --scenario "release*"
dynobox run --scenario "lint*,deploy package"
dynobox run --harness claude-code,codex --iterations 5
dynobox run --reporter json
```

Scenario filters match the compiled scenario name or id. Authored scenario IDs
can be matched with or without the `scenario.` prefix, even when JSON job IDs
are source-prefixed during multi-file discovery. Patterns support `*` for any
number of characters and `?` for one character. If no scenarios match, the run
exits with code `1`.

Harness selection preserves matching configured harness metadata. For example,
`dynobox run --harness codex` keeps a configured Codex `model` and
`permissionMode`. To temporarily use a different model, pass `--model` with one
model per selected harness. Positional values are matched after comma-separated
and repeated flags are flattened, so `--harness claude-code,codex --model
sonnet,gpt-5.5` maps `sonnet` to `claude-code` and `gpt-5.5` to `codex`.
`--permission-mode` still overrides the effective permission mode for every
selected harness.

Iterations are a runtime option, not part of dyno configs. `--iterations 5`
runs every selected scenario/harness pair five times and reports a per-row
job fraction with an inline sparkline such as `✗ 2/5 failed   .FF..`. Passing
marks are `.` and failing marks are `F`; marks are colored when ANSI color
output is enabled. Every failed iteration is listed under its row.

## Output Modes

Default output groups results by dyno, then by scenario. The header shows a
discovery summary (`discovered 1 dyno · 2 scenarios · harness: …`) including
model and permission mode in harness labels when configured. When a run spans
multiple harness labels, each scenario shows one aligned row per harness. A
single harness label is shown in the header but omitted from result rows to keep
the grouped output compact.

Failed rows show failed assertions with an `expected` line and an `observed`
line describing the evidence Dynobox actually saw. For path-aware tool
assertions, the rendered expectation includes the matched path, such as
`tool.called(read_file, path: package.json)`. Failed `command.called(...)`
assertions show a compact match-count summary by default.

The final summary leads with job counts (a job is one executed
`scenario × harness × iteration` unit); assertion detail is always labeled,
such as `✗ 1 of 2 jobs failed · 1 failed assertion · 1m02s`. Setup and
harness failures are counted separately as job errors.

`--quiet` prints a one-line discovery summary, compact `.`/`F` progress marks,
`FAIL`/`WARN` groups when needed, and the same job-led summary semantics.

`--verbose` uses the grouped layout and expands every job with setup, harness,
and assertion phase rows plus all assertion results, even when jobs pass. When
command assertions are present, verbose output also lists parsed command
segments observed during the run. Scenarios with CLI mocks list the configured
executable names and each recorded call with its exit code.

`--debug` prints everything `--verbose` does, includes temporary work-directory
and artifact paths, and writes debug logs inside each job's work directory when
data is available.
Debug logs can include:

- `dynobox-transcript.log`
- `dynobox-chat-history.jsonl`
- `dynobox-tool-events.json`
- `dynobox-cli-mocks.json`
- `dynobox-stderr.log`

`dynobox-cli-mocks.json` contains complete local call records: executable,
arguments, working directory, timestamp, exit code, stdout, and stderr. Child
environment values are not included.

`--reporter json` emits newline-delimited JSON on stdout instead of text.
Dynobox writes one job object per completed job, then one summary object. The
JSON reporter always uses static output so stdout remains machine-readable.

When stdout is an interactive terminal and live output is enabled, Dynobox
streams phase progress and harness tool events as they happen. In
non-interactive output, quiet mode, or incompatible terminals, it renders static
output after jobs complete.

## JSON Reporter

Every JSON reporter object includes `"schema": "dynobox.report.v2"` and a
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
- `observations.toolEventCount`, `observations.httpEventCount`,
  `observations.cliMockCallCount`, and `observations.harnessCliMockCallCount`
- `assertions`, with `assertionId`, optional `label`, `type`, `passed`, and
  `message`

`observations.cliMockCallCount` includes every completed mock call in the job,
including post-harness verification calls.
`observations.harnessCliMockCallCount` includes only calls completed during the
harness phase, matching the evidence available to observation assertions.

The summary record includes:

- `status`
- `totals.jobs`, `totals.passed`, `totals.failed`, `totals.configErrors`,
  `totals.warnings`, and `totals.durationMs`
- `plan.scenarios`, `plan.harnesses`, and `plan.iterations`
- `matrix.scenarios`, `matrix.harnesses`, `matrix.iterations`, and
  `matrix.cells` with aggregate `passed`, `failed`, `total`, and `failedJobs`
  fields
- `failedJobs`
- `warningJobs`

Example:

```bash
dynobox run --reporter json dynobox
```

In CI, redirect stdout to an artifact file:

```bash
dynobox run --reporter json examples/local-observability > dynobox-report.ndjson
```

## Exit Codes

Dynobox exits with `0` when all loaded jobs pass.

A no-argument `dynobox` invocation prints the starter banner to stdout and exits
with `0`.

Dynobox exits with `1` for:

- Config load, parse, validation, or flag errors.
- No dynos found for a directory path.
- At least one completed job failed.

## Harness Requirements

The CLI supports these real harnesses:

- `claude-code` invokes Claude Code with stream JSON output and hook events.
- `codex` invokes Codex with JSON output, no color, and the git-repo check
  skipped.
- `opencode` invokes OpenCode with JSON output and an explicit scenario work
  directory.

Make sure the selected harness executable is installed, authenticated, and
available on `PATH`.

Dynobox uses each harness's normal permission behavior by default. Use
`--permission-mode dangerous` only for trusted local evals that intentionally
need harness-specific access elevation or non-interactive approval bypasses.

Dangerous mode maps to harness-specific flags:

- `claude-code`: adds `--permission-mode bypassPermissions`.
- `codex`: adds `--sandbox danger-full-access -c approval_policy="never"`.
- `opencode`: adds `--auto`, which approves permission prompts but does not
  override explicit deny rules.

Permission warnings are advisory. They explain when a harness blocked a tool
action, but they do not change job status, assertion results, or exit codes.

## Saving Runs

`--save-run` uploads a compact summary of the run to the Dynobox dashboard after
execution. Dashboard uploads require a token: sign in with `dynobox login` or
set `DYNOBOX_TOKEN`. If no token is available, the command errors before running
any scenarios rather than wasting the run. When a token is present, the CLI
verifies it before local execution and retries transient verification failures
before asking you to try `--save-run` again later.

Set `DYNOBOX_UPLOAD_URL` to send the same JSON payload to an exact custom URL
instead. Custom uploads do not require Dynobox authentication and never include
the Dynobox `Authorization` header. Unlike `DYNOBOX_API_URL`, this overrides only
the saved-run POST destination and bypasses the Dynobox authentication preflight.
All uploads are best-effort: a failed upload prints a warning and never changes
job status, assertion results, or the exit code.

The uploaded summary includes the current Git commit, branch, dirty state, and
configured Git user name/email when available, plus scenario and assertion
details. For all jobs,
assertion records include the authored definition, display-ready
expectation/observed text, and compact matched evidence when available, including
requested HTTP endpoint URLs, tool commands, and verification output. This is
richer than the local `--reporter json` output. Failed jobs additionally include
diagnostics such as command and harness error output. These values are
length-capped but are **not redacted**, so avoid `--save-run` for runs whose Git
identity, assertion data, evidence, or diagnostics should not be shared.

## Dashboard

[dash.dynobox.xyz](https://dash.dynobox.xyz) is the Dynobox web dashboard. It is
used for CLI token creation and saved run pages. When `--save-run` uploads
successfully, the CLI prints the returned dashboard URL so you can review or
share the run.

## Development Checkout

See
[CONTRIBUTING.md](https://github.com/dynobox/dynobox/blob/main/CONTRIBUTING.md)
for local checkout workflows.
