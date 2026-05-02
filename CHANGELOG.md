# Changelog

All notable changes to published Dynobox packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dynobox uses per-package versioning. Tags follow `<package-name>@<version>` (e.g. `dynobox@0.0.3`).

## [Unreleased]

### `dynobox` (CLI)

### `@dynobox/sdk`

---

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
