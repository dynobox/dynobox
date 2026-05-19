# Changelog

All notable changes to published Dynobox packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dynobox uses per-package versioning. Tags follow `<package-name>@<version>` (e.g. `dynobox@0.0.3`).

## [Unreleased]

### `dynobox` (CLI)

- Added `dynobox run --reporter json` for newline-delimited machine-readable job and summary output.
- Added local HTTP capture and evaluation for `http.called(...)` and `http.notCalled(...)` assertions, including status checks for proxy-observed child-process traffic.
- Fixed directory discovery so explicitly provided hidden roots such as `.agents/skills` are searched while hidden entries below the root remain skipped.

---

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
