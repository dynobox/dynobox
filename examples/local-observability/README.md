# Local Observability Example

This example demonstrates Dynobox's local runner with two `*.dyno.mjs`
files. Running it shows two things at once:

1. `dynobox run <directory>` discovers and runs every `*.dyno.mjs` file
   in the directory tree.
2. `tool.called`, `artifact.contains`, and `finalMessage.contains`
   assertions evaluate observed harness behavior in a scratch work
   directory.

## Run

From the repository root:

```bash
pnpm --filter dynobox... build
node packages/cli/dist/bin.js run examples/local-observability
```

Or, after installing the published CLI globally:

```bash
dynobox run examples/local-observability
```

Prerequisites:

- `claude` is installed and available on `PATH`.
- Claude Code supports `-p`, `--output-format stream-json`, and
  `--include-hook-events`.

## Files

- `inspect-package.dyno.mjs` — asks Claude Code to inspect `package.json`
  with a shell command, then asserts that a `shell` tool was called and
  that the command mentioned `package.json`.
- `add-script.dyno.mjs` — asks Claude Code to add a `lint` script to
  `package.json`, then asserts the artifact contains the new entry and
  the final response mentions `lint`.

Each file is a self-contained dyno: it declares its own `setup`, prompt,
and assertions. Discovery treats files independently.

## Assertion Semantics

`tool.called('shell')` observes shell tool calls reported by the
harness — it does not trace arbitrary OS processes.

`tool.called('shell', {includes: 'package.json'})` passes when a
captured shell command string contains `package.json`.

`artifact.contains(path, text)` reads the file from the scratch work
directory after the harness finishes and looks for `text`.

`finalMessage.contains(text)` checks the last assistant message for
`text`.

Setup commands run before the harness starts and do not count as
harness shell tool calls.
