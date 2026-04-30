# Local Observability Example

This is the fastest local runner smoke test for Dynobox. It runs one Claude Code scenario in a scratch work directory and verifies observed harness tool usage with `tool.called` assertions.

The scenario setup creates a tiny `package.json` in the scratch directory. The prompt asks Claude Code to inspect that file with a shell command.

## Run

From the repository root:

```bash
pnpm --filter dynobox... build
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts
```

Prerequisites:

- `claude` is installed and available on `PATH`.
- Claude Code supports `-p`, `--output-format stream-json`, and `--include-hook-events`.

Expected output shape:

```text
dynobox run

config: examples/local-observability/dynobox.config.ts
jobs: 1

[1/1] inspect package scripts claude-code iter 1 PASS

Assertions:
PASS tool.called(shell)
PASS tool.called(shell, includes: package.json)
```

## Assertion Semantics

`tool.called('shell')` observes shell tool calls reported by the harness. It does not trace arbitrary operating system processes.

`tool.called('shell', {includes: 'package.json'})` passes when a captured shell command string contains `package.json`.

Setup commands are run by Dynobox before the harness starts. They prepare the scratch directory but are not counted as harness shell tool calls.
