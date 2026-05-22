# dynobox

Cross-harness testing for multi-step agent and skill workflows.

Dynobox runs agent scenarios through local harnesses such as Claude Code and
Codex, captures observable behavior, and evaluates assertions against what
actually happened.

- Site: [dynobox.xyz](https://dynobox.xyz)
- Docs: [docs.dynobox.xyz](https://docs.dynobox.xyz)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Install

```bash
npm install -g dynobox
```

The selected harness executable must already be installed, authenticated, and
available on `PATH`.

## Quick Start

Create a starter dyno file, then run it:

```bash
dynobox init
dynobox run
```

`dynobox init` writes `dynobox/example.dyno.mjs` by default. `dynobox run` with
no argument discovers `*.dyno.{mjs,js,ts,mts,yaml,yml}` files recursively under
the current directory.

Scope a run to a directory or file:

```bash
dynobox run dynobox
dynobox run my-skill.dyno.yaml
```

Pick a harness at runtime when needed:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
```

## What You Can Assert

Dynobox supports assertions for:

- Tool calls with `tool.called(...)` and `tool.notCalled(...)`.
- Shell command matchers with `equals`, `includes`, `startsWith`, or `matches`.
- Ordered tool-call sequences.
- Skill instruction loading.
- Work-directory artifacts.
- Harness transcript and final response text.
- HTTP requests from local child-process tools that honor proxy environment
  variables.

## Output Modes

- `--quiet`: compact dots-and-failures output for CI.
- `--verbose`: expand scenario details even when they pass.
- `--debug`: include work directory, artifact paths, and debug log paths.
- `--reporter json`: emit newline-delimited JSON reports.
- `--permission-mode default|dangerous`: override harness permission behavior.

## Documentation

- [Getting Started](https://docs.dynobox.xyz/getting-started)
- [Config Authoring](https://docs.dynobox.xyz/config-authoring)
- [CLI Reference](https://docs.dynobox.xyz/cli)
