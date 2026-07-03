# Dynobox

[![npm version](https://img.shields.io/npm/v/dynobox.svg)](https://www.npmjs.com/package/dynobox)
[![License](https://img.shields.io/github/license/dynobox/dynobox.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/dynobox/dynobox/ci.yml?branch=main&label=ci)](https://github.com/dynobox/dynobox/actions)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

Cross-harness testing for multi-step agent and skill workflows.

**Status:** Early access. Dynobox is ready for local skill and agent workflow testing while the CLI, SDK, and report formats continue to evolve before 1.0.

Dynobox runs agent scenarios through local harnesses such as Claude Code and Codex, captures observable behavior, and evaluates assertions against what actually happened. It is designed for testing skills and agent flows where you care about tool usage, file effects, transcripts, final answers, and behavior across harnesses.

## Why Use It

Use Dynobox when you want to answer questions like:

- Does this skill call the expected tools?
- Does it avoid dangerous or unrelated commands?
- Does it create or preserve the right files?
- Does its final answer include required information?
- Does the same task work under Claude Code and Codex?

## Quick Start

Install the CLI and a starter dyno file, then run it:

```bash
npm install -g dynobox
dynobox init        # writes dynobox/example.dyno.mjs
dynobox discover    # prints the *.dyno.* files that run would load
dynobox run         # discovers and runs every *.dyno.* file under the cwd
```

`dynobox run` with no argument discovers `*.dyno.{mjs,js,ts,mts,yaml,yml}` files
recursively under the current directory. Pass a directory or a single file to scope it:

```bash
dynobox run examples/local-observability
dynobox run my-skill.dyno.yaml
```

Pick a harness at runtime when needed (each authored file declares its own
default list):

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
```

Run each selected scenario/harness pair more than once to measure pass rates:

```bash
dynobox run --harness claude-code,codex --iterations 5
```

The selected harness executable must already be installed, authenticated, and
available on `PATH`.

## Example: A Dyno File

```ts
// my-skill.dyno.mjs
import {artifact, command, defineDyno, finalMessage, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'package-script-skill',
  harnesses: [{id: 'claude-code', permissionMode: 'default'}],
  scenarios: [
    {
      name: 'detects test script',
      setup: [
        `cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {"test": "vitest run"}
}
JSON`,
      ],
      prompt:
        'Use `cat package.json` and tell me whether this project has a test script.',
      assertions: [
        command.called('cat', {args: ['package.json']}),
        tool.notCalled('edit_file'),
        artifact.contains('package.json', 'vitest run'),
        finalMessage.contains('test'),
      ],
    },
  ],
});
```

The same dyno authored in YAML:

```yaml
# my-skill.dyno.yaml
name: package-script-skill
harnesses:
  - id: claude-code
    permissionMode: default
scenarios:
  - name: detects test script
    prompt: >-
      Use cat package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {"scripts":{"test":"vitest run"}}
        JSON
    assertions:
      - label: reads package.json
        type: command.called
        executable: cat
        command: {args: [package.json]}
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: vitest run
      - type: finalMessage.contains
        text: test
```

See [Getting Started](./docs/getting-started.md) for the full walkthrough and
[Config Authoring](./docs/config-authoring.md) for the YAML / TS assertion
reference.

## Documentation

- [Docs index](./docs/README.md)
- [Getting Started](./docs/getting-started.md)
- [Config Authoring](./docs/config-authoring.md)
- [CLI Reference](./docs/cli.md)

## Current Capabilities

- Discover and run `*.dyno.{mjs,js,ts,mts,yaml,yml}` files with
  `dynobox run [path]` — no arg = cwd, directory = recursive, file = single
  run. Legacy explicit-file paths (e.g. `dynobox.config.ts`) keep working.
- Scaffold a starter file with `dynobox init` (`--yaml` for YAML, `--harness`
  to pin the starter harness).
- Authenticate with `dynobox login`, verify with `dynobox whoami`, and remove
  saved tokens with `dynobox logout`.
- Author dynos in TypeScript / JavaScript with `@dynobox/sdk` helpers
  (`defineDyno`, `defineScenario`, `tool`, `skill`, `artifact`, `transcript`,
  `finalMessage`, `sequence`, `http`, `dyno`) or in YAML using the same shape
  with `type`-discriminated assertion objects.
- Automatically copy adjacent `fixtures/` directories for JS/TS dynos authored
  with `defineDyno(...)`, and automatically copy `SKILL.md` for dynos authored
  under `.agents/skills/<name>/` or `.claude/skills/<name>/`.
- Run locally against Claude Code, Codex, or both.
- Select harnesses at runtime with `--harness claude-code`, `--harness codex`,
  or comma-separated values while preserving configured model metadata.
- Override selected harness models positionally with `--model`, such as
  `--harness claude-code,codex --model sonnet,gpt-5.5`.
- Filter scenarios at runtime with `--scenario <pattern>`.
- Repeat each scenario/harness pair with `--iterations <count>` and view
  sparkline pass-rate matrix cells such as `.F...`.
- Configure harness permission behavior with `permissionMode` or
  `--permission-mode`; dangerous full-access modes are opt-in.
- Emit newline-delimited JSON reports with `--reporter json`.
- Upload compact dashboard summaries with `--save-run` when authenticated.
- Assert tool calls with `tool.called(...)` and `tool.notCalled(...)`.
- Match file-oriented tool calls by path, such as
  `tool.called('read_file', {path: 'package.json'})`.
- Assert skill instruction file references with `skill.referenced(...)`.
- Assert normalized shell commands with `command.called(...)` and
  `command.notCalled(...)`; raw shell string matchers remain available as
  escape hatches.
- Assert HTTP requests to declared endpoints with `http.called(...)` and
  `http.notCalled(...)`.
- Express valid alternative behavior paths with `anyOf(...)`.
- Assert ordered tool-call sequences with `sequence.inOrder(...)`.
- Assert work-directory artifacts with `artifact.exists(...)` and
  `artifact.contains(...)`.
- Assert harness transcript and final response text with
  `transcript.contains(...)` and `finalMessage.contains(...)`.
- Run post-harness checks with `verify.command(...)` for generated artifacts.
- Stream live progress and tool events in interactive terminals.
- Use default, `--quiet`, `--verbose`, and `--debug` output modes, including
  debug log paths for transcripts, raw chat JSONL, and normalized tool events.

HTTP endpoint declarations and HTTP assertions can evaluate local child-process
traffic that honors proxy and CA environment variables. Harness-native web
tools and binaries with their own trust stores may bypass local HTTPS capture.

## Packages

This repository is a pnpm monorepo. Published packages live under `packages/`.

| Package                                            | Registry                                                     | Description                                            |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| [`dynobox`](./packages/cli)                        | [`dynobox`](https://www.npmjs.com/package/dynobox)           | CLI for loading configs and running local scenarios    |
| [`@dynobox/sdk`](./packages/sdk)                   | [`@dynobox/sdk`](https://www.npmjs.com/package/@dynobox/sdk) | SDK for authoring configs and compiling canonical IR   |
| [`@dynobox/run-schema`](./packages/run-schema)     | GitHub Packages                                              | Shared run upload schema and API response types        |
| [`@dynobox/runner-local`](./packages/runner-local) | Unpublished                                                  | Local runner for harness execution and tool assertions |
| [`@dynobox/evaluators`](./packages/evaluators)     | Unpublished                                                  | Assertion evaluators shared by runner code             |

`@dynobox/run-schema` is published to GitHub Packages under the `@dynobox` scope. `@dynobox/runner-local` and `@dynobox/evaluators` are private workspace packages bundled into the published `dynobox` CLI instead of exposed as public dependencies.

## Project Site

[dynobox.xyz](https://dynobox.xyz)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development commands and
checkout workflows.

## License

Apache-2.0 for all code in this repository. See [LICENSE](./LICENSE).
