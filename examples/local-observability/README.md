# Local Observability Example

This example demonstrates Dynobox's local runner with two `*.dyno.mjs`
files. Running it shows two things at once:

1. `dynobox run <directory>` discovers and runs every `*.dyno.mjs` file
   in the directory tree.
2. `command.called`, `artifact.contains`, and `finalMessage.contains`
   assertions evaluate observed behavior and final work-directory state.

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
  with `cat package.json`, then asserts that exact command was observed and
  the final answer mentioned the test script.
- `add-script.dyno.mjs` — asks Claude Code to add a `lint` script to
  `package.json` with `node -e`, then asserts that command was observed, the
  artifact contains the new entry, and the final response mentions `lint`.

Each file is a self-contained dyno: it declares its own `setup`, prompt,
and assertions. Discovery treats files independently.

## Assertion Semantics

`command.called(executable, matcher)` observes normalized shell command
segments reported by the harness. It is more useful than asserting that the
generic shell tool was called because it names the command behavior the agent
actually performed.

`command.called('cat', {args: ['package.json']})` passes when the agent ran a
normalized `cat` command whose args included `package.json`.

`artifact.contains(path, text)` reads the file from the scratch work
directory after the harness finishes and looks for `text`.

`finalMessage.contains(text)` checks the last assistant message for
`text`.

Setup commands run before the harness starts and do not count as
harness shell tool calls.
