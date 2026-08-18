# Changelog

All notable changes to published Dynobox packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dynobox uses per-package versioning. Tags follow `<package-name>@<version>` (e.g. `dynobox@0.0.3`).

## [Unreleased]

---

## dynobox@0.12.0 — 2026-08-18

### `dynobox` (CLI)

- Added Pi harness execution with JSONL tool and final-message capture, model
  selection, permission approval, and non-persistent sessions.
- Added Cursor CLI harness execution with stream-json tool and final-message
  capture, model selection, workspace trust, default Cursor permissions, and
  dangerous-mode command auto-approval and sandbox disable. Host MCP
  auto-approval is not enabled.
- Added Google Antigravity CLI harness execution for AGY 1.1.14 or newer with
  stream-json tool and final-message capture, model selection, documented
  Gemini API-key authentication, isolated per-run projects, default Antigravity
  permissions, and dangerous-mode tool auto-approval. Print mode sets
  `--print-timeout` to the Dynobox job timeout, or 30 minutes when unset, so
  AGY's default five-minute cap does not cut off long evals.

## @dynobox/sdk@0.8.0 — 2026-08-18

### `@dynobox/sdk`

- Added `pi` as a supported harness ID.
- Added `cursor` as a supported harness ID.
- Added `antigravity` as a supported harness ID.

---

## dynobox@0.11.1 — 2026-08-09

### `dynobox` (CLI)

- Fixed CLI mocks being bypassed by common zsh, bash, and interactive POSIX
  shell startup PATH changes or by Codex login shells and shell snapshots,
  while preserving Codex shell-environment filtering.

---

## dynobox@0.11.0 — 2026-08-07

### `dynobox` (CLI)

- Added experimental scenario-scoped CLI mocks with static, sequential, and
  handler responses, local call recording, command assertion integration, YAML
  support, and verbose/debug/JSON reporting.
- Added unauthenticated custom run uploads through `DYNOBOX_UPLOAD_URL` and
  included current Git revision, branch, dirty state, and configured identity in
  run payloads.

## @dynobox/sdk@0.7.0 — 2026-08-07

### `@dynobox/sdk`

- Added experimental scenario `cliMocks` authoring types and validation.

---

## @dynobox/run-schema@0.4.0 — 2026-08-06

### `@dynobox/run-schema`

- Added run upload schema v4 with structured Git metadata and exposed that
  metadata in stored run response types.

## dynobox@0.10.2 — 2026-07-28

### `dynobox` (CLI)

- Added masked token feedback to the interactive `dynobox login` prompt.

## dynobox@0.10.1 — 2026-07-22

### `dynobox` (CLI)

- Updated the shipped `tsx` dependency and bundled `shell-quote` parser to
  patched versions.
- Included license notices for bundled third-party code.

## @dynobox/run-schema@0.3.1 — 2026-07-22

### `@dynobox/run-schema`

- Added a prepack build and included the Apache-2.0 license in package tarballs.

## dynobox@0.10.0 — 2026-07-21

### `dynobox` (CLI)

- Added OpenCode harness execution with JSONL tool and final-message capture,
  model selection, and dangerous-mode permission auto-approval.

## @dynobox/sdk@0.6.0 — 2026-07-21

### `@dynobox/sdk`

- Added `opencode` as a supported harness ID.

## dynobox@0.9.3 — 2026-07-15

### `dynobox` (CLI)

- Fixed uploaded shell evidence to preserve the original tool name and command.

## dynobox@0.9.2 — 2026-07-14

### `dynobox` (CLI)

- Added the evaluator-selected `anyOf` branch index to saved-run evidence and
  local JSON reports when a branch matches.

## @dynobox/run-schema@0.3.0 — 2026-07-14

### `@dynobox/run-schema`

- Added optional positive `matchedBranchIndex` assertion evidence for selected
  `anyOf` branches without changing the v3 upload protocol.

## dynobox@0.9.1 — 2026-07-14

### `dynobox` (CLI)

- Added nullable Claude Code and Codex executable versions to local JSON reports
  and schema v3 saved-run uploads. Save-run API failures now include structured
  error details without changing the scenario result.

## @dynobox/run-schema@0.2.0 — 2026-07-14

### `@dynobox/run-schema`

- Added run upload schema v3 with nullable `harness.version` provenance.
  Schema v2 remains strict and available for backward-compatible API handling.

## dynobox@0.9.0 — 2026-07-10

### `dynobox` (CLI)

- Rendered diagnostics for `artifact.notExists` and `artifact.unchanged`,
  including resolved paths, baseline/final byte sizes, and nested verification
  exit code, stdout, and stderr when every `anyOf` branch fails.
- Preserved new artifact path fields and nested verification definition fields
  in `--save-run` upload payloads.

## @dynobox/sdk@0.5.0 — 2026-07-10

### `@dynobox/sdk`

- Added `artifact.notExists(path)` to assert a workdir path is truly absent
  (files, directories, valid symlinks, and dangling symlinks all fail).
  `artifact.exists` and `artifact.notExists` both use `lstat` presence, so
  dangling symlinks count as present for both.
- Added `artifact.unchanged(path)` to assert a regular file matches the
  post-setup baseline (size + SHA-256 of raw bytes) captured before the harness
  starts.
- Allowed `verify.command(...)` and `verify.succeeds(...)` as `anyOf([...])`
  branches. Nested verification commands receive stable synthetic branch IDs
  (`${anyOfId}#branch:${n}`, collision-safe vs authored ids) and cannot
  retroactively change observation-branch artifact results.
- Changed authored skill staging so `defineDyno(...)` copies `SKILL.md` into
  both `.agents/skills/<name>/` and `.claude/skills/<name>/` (authored root
  first).

---

## dynobox@0.8.1 — 2026-07-09

### `dynobox` (CLI)

- Fixed `command.called(...)` normalization so subshell `(...)` and brace-group
  `{...}` wrappers (common for exit-code capture) yield the same observed
  commands as their ungrouped forms.
- Improved `command.called(...)` failure messages when an executable appears in
  raw shell text but not among normalized commands, including the matching raw
  shell line(s).

---

## dynobox@0.8.0 — 2026-07-07

### `dynobox` (CLI)

- Fixed grouped, quiet, live, and saved-run assertion details so duplicate
  assertion IDs across dyno files resolve against the correct job definition.

---

## dynobox@0.7.1 — 2026-07-02

### `dynobox` (CLI)

- Updated the bundled `@dynobox/sdk` dependency to `0.4.1` so `dynobox run`
  and `dynobox validate` pick up the `defineDyno(...)` authoring defaults fix
  for dynos loaded from published or `npx` SDK paths.

## @dynobox/sdk@0.4.1 — 2026-07-02

### `@dynobox/sdk`

- Fixed `defineDyno(...)` authoring defaults so dynos loaded from published or
  `npx` SDK paths correctly attach adjacent `fixtures/` directories and skill
  `SKILL.md` setup. Caller inference now recognizes the SDK's own installed
  module path as an SDK frame instead of treating it as the dyno file.

## @dynobox/sdk@0.4.0 — 2026-07-02

### `@dynobox/sdk`

- **Breaking:** Renamed `skill.invoked(...)` assertions to
  `skill.referenced(...)`, including the authored config type and compiled IR
  type.
- **Breaking:** Bumped compiled IR to `0.3` and aligned assertion fields with
  authoring: `kind` is now `type`, `toolKind` is now `tool`, shell and command
  matchers use `command`, and path matchers use top-level `path`.
- **Breaking:** Removed unused `headers`, `body`, and `response` endpoint spec
  fields. Endpoint specs now contain only `method` and `url`.

## dynobox@0.7.0 — 2026-07-02

### `dynobox` (CLI)

- **Breaking:** Updated skill assertion evaluation and rendering to use
  `skill.referenced(...)` for observed `SKILL.md` file references.
- **Breaking:** Changed `dynobox run --save-run` uploads to emit run upload
  schema v2.
- **Breaking:** Bumped `dynobox run --reporter json` output to
  `dynobox.report.v2` and changed assertion records from `kind` to `type`.
- Changed failed `command.called(...)` assertions to show a compact match-count
  summary by default and parsed command segments in verbose output.
- Changed `dynobox run --save-run` to verify authentication before local
  execution, retry transient verification failures, and fail fast for invalid
  tokens before running scenarios.

## @dynobox/run-schema@0.1.0 — 2026-06-28

### `@dynobox/run-schema`

- **Breaking:** Replaced run upload schema v1 with schema v2. Upload assertion
  records, definitions, and display children now use `type` instead of `kind`,
  `tool` instead of `toolKind`, unified `command` details, and top-level `path`.

## @dynobox/run-schema@0.0.10 — 2026-06-24

### `@dynobox/run-schema`

- Added full assertion branch definitions for `anyOf` upload metadata.

## @dynobox/run-schema@0.0.9 — 2026-06-20

### `@dynobox/run-schema`

- Added `verify.command` assertion definition fields for command, exit code,
  stdout, and stderr upload metadata.
- Changed verify assertion stdout/stderr matchers to allow empty string
  expectations while keeping other assertion matchers non-empty.

## @dynobox/run-schema@0.0.8 — 2026-06-19

### `@dynobox/run-schema`

- Added normalized command assertion metadata, including executable, parsed
  command matcher args, ordered args, regex args, and original command matching.

## dynobox@0.6.0 — 2026-06-16

### `dynobox` (CLI)

- Added `dynobox validate` to discover, load, and compile dyno configs without
  running harnesses, with text and newline-delimited JSON reporters.
- Added `dynobox discover` to preview discovery-backed dyno selection from the
  CLI.
- Added JSON project config via `dyno.config.json` and `--config <path>`, with
  `ignoredDirectories` support for discovery-backed commands.
- Changed discovery-backed commands to include `.agents` and `.claude` skill
  directories while still skipping other dot directories by default.
- Added `dynobox run --model` for positional model overrides alongside
  `--harness`, and changed targeted harness runs to preserve configured harness
  model and permission metadata.
- Fixed duplicate `--harness`/`--model` pairs so identical selected runs execute
  once instead of producing duplicate job IDs.

## @dynobox/sdk@0.3.0 — 2026-06-13

### `@dynobox/sdk`

- Added optional top-level `target` support to authored configs and compiled IR
  so dynos can name the product or workflow surface used for saved-run grouping.

## dynobox@0.5.0 — 2026-06-13

### `dynobox` (CLI)

- Added `dynobox run --save-run` to upload compact run summaries to the
  dashboard when authenticated, with best-effort upload warnings that do not
  affect run status.
- Added an optional top-level `target` field to dyno files (TypeScript and
  YAML) naming the thing being tested; when omitted it defaults to the dyno
  file's parent directory name.
- Changed `--save-run` uploads to report each dyno (with its target) as its
  own group inside the run payload.

- Added `dynobox --version` (`-V`) to print the installed CLI version.
- Added `dynobox logout` to remove the saved CLI token, noting when
  `DYNOBOX_TOKEN` remains set in the environment.
- Added valid value hints for `--harness` and `--permission-mode` to
  `dynobox run --help` (and `dynobox init --harness`).
- Changed the no-argument `dynobox` invocation to print the starter banner to
  stdout and exit 0 instead of stderr with a non-zero exit.
- Changed `dynobox login` to read the pasted token without echoing it on a
  terminal, while still accepting piped input for CI.
- Changed `dynobox whoami` to report whether the active token came from the
  saved config file or the `DYNOBOX_TOKEN` environment variable.

---

## @dynobox/run-schema@0.0.5 — 2026-06-10

### `@dynobox/run-schema`

- Added harness IDs to target recent-run references so dashboard target history
  can show which harnesses were tested in each run.

## @dynobox/run-schema@0.0.4 — 2026-06-10

### `@dynobox/run-schema`

- **Breaking:** Renamed the run-level `target` field to `inputPath` — it
  records the path the CLI was pointed at, not the thing being tested.
- **Breaking:** Restructured run uploads to group jobs by source dyno: the
  top-level `jobs` array is replaced by `dynos`, where each dyno carries its
  `dynoPath`, optional authored `name`, `target` (the thing being tested),
  per-dyno `status`/`totals`, and its `jobs`.
- Reworked the read types around the target-first hierarchy
  (`Target -> Dyno -> Scenario -> Job -> Assertion`): `RunSummary` gains
  target/dyno/assertion counts, `RunJobDetail` gains its owning `dyno`, and
  new `TargetSummary`, `TargetDynoSummary`, `DynoRunDetail`, and matching
  response types back the target/dyno dashboard endpoints.
- Removed the unused `RunInsertV1`/`RunJobInsertV1`/`RunAssertionInsertV1`
  helper types and the `RunGitHashMetric` metrics from `RunListResponse`.

## @dynobox/run-schema@0.0.3 — 2026-06-09

### `@dynobox/run-schema`

- Added assertion `definition`, `display`, and `evidence` to the run upload
  schema and the matching read types (`RunAssertionDetail`, `RunDetail`),
  letting consumers render rich assertion expectation/observed detail and
  ordered-sequence step breakdowns.

## @dynobox/run-schema@0.0.2 — 2026-06-03

### `@dynobox/run-schema`

- Added a shared run upload contract package with Zod schemas and TypeScript
  types for run totals, jobs, assertions, diagnostics, warnings, and upload
  insert shapes.

## dynobox@0.4.0 — 2026-05-31

### `dynobox` (CLI)

- Added `dynobox login` for saving dashboard-generated CLI tokens to local
  config, with support for `DYNOBOX_TOKEN`, `DYNOBOX_API_URL`, and
  `DYNOBOX_DASHBOARD_URL` overrides.
- Added token validation during `dynobox login`, including clear errors for
  invalid, revoked, expired, unreachable, or unexpected API responses.
- Added `dynobox whoami` for verifying the saved CLI identity and reporting the
  authenticated email when available.
- Documented CLI token authentication and 24-hour token expiry in the npm README.

## dynobox@0.3.0 — 2026-05-25

### `dynobox` (CLI)

- Added `dynobox run --iterations <count>` to repeat selected
  scenario/harness pairs and render sparkline pass-rate matrices.
- Added aggregate matrix data to JSON summary reports.

## @dynobox/sdk@0.2.0 — 2026-05-23

### `@dynobox/sdk`

- Fixed `dyno.here(...).fixtures('subpath')` to resolve subpaths inside the
  adjacent `fixtures/` directory.
- Added path matchers for file-oriented tool assertions such as
  `tool.called('read_file', {path: 'package.json'})`.
- Made `defineDyno(...)` automatically attach an adjacent `fixtures/`
  directory to scenarios that do not explicitly set fixtures.
- Made `defineDyno(...)` automatically copy `SKILL.md` for dynos authored
  under `.agents/skills/<name>/` or `.claude/skills/<name>/`.
- Removed the fixture-aware `dyno.here(...).defineDyno(...)` wrapper so
  `dyno.here(...)` only provides path helpers.

## dynobox@0.2.2 — 2026-05-23

### `dynobox` (CLI)

- Fixed `dynobox run --scenario` so authored scenario IDs still match when
  discovered dyno files use source-prefixed JSON job IDs.
- Replaced the no-args placeholder banner with a starter usage hint.
- Improved failed assertion output so `observed` lines show the actual
  observed evidence instead of repeating the expectation.
- Render path-aware tool assertions in CLI output.
- Covered JS dynos that rely on adjacent fixture auto-copying.

## @dynobox/sdk@0.1.1 — 2026-05-22

### `@dynobox/sdk`

- Updated package metadata and npm README links to use `dynobox.xyz`.
- Removed checkout-only development commands from the npm README.

## dynobox@0.2.1 — 2026-05-22

### `dynobox` (CLI)

- Updated package metadata, CLI follow-along output, and npm README links to
  use `dynobox.xyz`.
- Reworked the npm README around install and usage, moving local checkout
  development commands into `CONTRIBUTING.md`.

## @dynobox/sdk@0.1.0 — 2026-05-22

### `@dynobox/sdk`

- Changed the authoring assertion object shape to use `type`, `tool`, and
  `command` instead of `kind`, `toolKind`, and `matcher`, keeping SDK helper
  output and YAML declarations aligned.
- Added optional scenario and assertion IDs plus assertion labels for stable
  references and clearer output.

## dynobox@0.2.0 — 2026-05-22

### `dynobox` (CLI)

- Updated YAML dyno authoring, starter templates, examples, and docs for the
  shared `type` / `tool` / `command` assertion contract.
- Added assertion labels to text output and JSON reporter assertion records.

## dynobox@0.1.0 — 2026-05-20

### `dynobox` (CLI)

- Added permission-denied warnings for harness tool failures in text and JSON run output.
- Added `dynobox run --scenario` for filtering runs by scenario name or id.
- Added `dynobox run --reporter json` for newline-delimited machine-readable job and summary output.
- Added local HTTP capture and evaluation for `http.called(...)` and `http.notCalled(...)` assertions, including status checks for proxy-observed child-process traffic.
- Fixed directory discovery so explicitly provided hidden roots such as `.agents/skills` are searched while hidden entries below the root remain skipped.

## dynobox@0.0.10 — 2026-05-10

### `dynobox` (CLI)

- Added evaluation and output rendering for `skill.invoked(...)` assertions.
- Added `--permission-mode` for explicit harness permission overrides, with dangerous full-access behavior now opt-in.
- Added debug log paths for raw chat JSONL, normalized tool events, transcripts, and harness stderr when available.

## @dynobox/sdk@0.0.6 — 2026-05-10

### `@dynobox/sdk`

- Added `skill.invoked(...)` for asserting observable skill instruction loading.
- Added `permissionMode` to harness config entries.

## @dynobox/sdk@0.0.5 — 2026-05-09

### `@dynobox/sdk`

- Split authoring, compiler, and IR exports into explicit package entrypoints.
- Tightened SDK helper naming, endpoint key validation, and config path shell quoting.
- Renamed the authoring helper from `defineConfig` to `defineDyno`.

## dynobox@0.0.9 — 2026-05-09

### `dynobox` (CLI)

- Hardened the CLI package as bin-only and reorganized internal rendering helpers without changing command behavior.

## @dynobox/sdk@0.0.4 — 2026-05-08

### `@dynobox/sdk`

- Included SDK formatting updates from the CLI runtime refactor release.

## dynobox@0.0.8 — 2026-05-08

### `dynobox` (CLI)

- Refactored CLI runtime internals into focused modules without changing the public CLI behavior.
- Added focused unit coverage for job building, command execution, option parsing, and render helpers.

## dynobox@0.0.7 — 2026-05-03

### `dynobox` (CLI)

- Added Codex local harness registration.
- Added `--harness` run overrides for selecting config harnesses at runtime.
- Added model-specific harness labels in run output.
- Fixed ordered shell sequence assertions so multiple steps can match one compound shell command.

## @dynobox/sdk@0.0.3 — 2026-05-03

### `@dynobox/sdk`

- Replaced single-harness config fields with `harnesses: [...]` in authored configs and compiled IR.
- Added model-specific harness config entries.

## dynobox@0.0.6 — 2026-05-02

### `dynobox`

- Fixed live progress rendering for multiline shell commands so spinner updates stay on one row.

## @dynobox/sdk@0.0.2 — 2026-05-02

### `@dynobox/sdk`

- Added assertion helpers for negative tool calls, artifacts, transcripts, final messages, and ordered tool sequences.
- Added `dyno` helpers for config-relative fixture paths and shell quoting.

## dynobox@0.0.5 — 2026-05-02

### `dynobox`

- Added rendering for artifact, transcript, final message, negative tool, and ordered sequence assertion results.

## dynobox@0.0.4 — 2026-05-01

### `dynobox`

- Bundled private runner and evaluator workspace packages into the CLI package so `dynobox` installs without unpublished internal dependencies.

## dynobox@0.0.3 — 2026-05-01

### `dynobox`

- Placeholder CLI with `dynobox run <config>` command.
- Local runner integration with Claude Code harness.
- Tool assertion evaluation via `tool.called()`.

## @dynobox/sdk@0.0.1 — 2026-05-01

### `@dynobox/sdk`

- Initial SDK with `defineConfig`, `defineScenario`, `tool`, and `http` helpers.
- IR compiler producing canonical Dynobox IR v0.1.
- Zod-based config validation.
