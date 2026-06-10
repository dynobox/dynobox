# Changelog

All notable changes to published Dynobox packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dynobox uses per-package versioning. Tags follow `<package-name>@<version>` (e.g. `dynobox@0.0.3`).

## [Unreleased]

### `dynobox` (CLI)

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
