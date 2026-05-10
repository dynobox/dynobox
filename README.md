# Dynobox

Cross-harness testing for multi-step agent and skill workflows.

**Status:** Under active development. Dynobox is usable for local experimentation, but APIs and output formats may still change.

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
dynobox run         # discovers and runs every *.dyno.* file under the cwd
```

`dynobox run` with no argument discovers `*.dyno.{mjs,cjs,js,ts,mts,cts,yaml,yml}` files
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

The selected harness executable must already be installed, authenticated, and
available on `PATH`.

## Example: A Dyno File

```ts
// my-skill.dyno.mjs
import {artifact, defineDyno, finalMessage, tool} from '@dynobox/sdk';

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
        'Inspect package.json and tell me whether this project has a test script.',
      assertions: [
        tool.called('shell', {includes: 'package.json'}),
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
      Inspect package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {"scripts":{"test":"vitest run"}}
        JSON
    assertions:
      - kind: tool.called
        toolKind: shell
        matcher: {includes: package.json}
      - kind: tool.notCalled
        toolKind: edit_file
      - kind: artifact.contains
        path: package.json
        text: vitest run
      - kind: finalMessage.contains
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

- Discover and run `*.dyno.{mjs,cjs,js,ts,mts,cts,yaml,yml}` files with
  `dynobox run [path]` — no arg = cwd, directory = recursive, file = single
  run. Legacy explicit-file paths (e.g. `dynobox.config.ts`) keep working.
- Scaffold a starter file with `dynobox init` (`--yaml` for YAML, `--harness`
  to pin the starter harness).
- Author dynos in TypeScript / JavaScript with `@dynobox/sdk` helpers
  (`defineDyno`, `defineScenario`, `tool`, `skill`, `artifact`, `transcript`,
  `finalMessage`, `sequence`, `http`, `dyno`) or in YAML using the same shape
  with `kind`-discriminated assertion objects.
- Run locally against Claude Code, Codex, or both.
- Override harnesses at runtime with `--harness claude-code`, `--harness codex`,
  or comma-separated values.
- Configure harness permission behavior with `permissionMode` or
  `--permission-mode`; dangerous full-access modes are opt-in.
- Assert tool calls with `tool.called(...)` and `tool.notCalled(...)`.
- Assert skill instruction loading with `skill.invoked(...)`.
- Match shell commands with `equals`, `includes`, `startsWith`, or `matches`.
- Assert ordered tool-call sequences with `sequence.inOrder(...)`.
- Assert work-directory artifacts with `artifact.exists(...)` and
  `artifact.contains(...)`.
- Assert harness transcript and final response text with
  `transcript.contains(...)` and `finalMessage.contains(...)`.
- Stream live progress and tool events in interactive terminals.
- Use default, `--quiet`, `--verbose`, and `--debug` output modes, including
  debug log paths for transcripts, raw chat JSONL, and normalized tool events.

HTTP endpoint declarations and HTTP assertions exist in the SDK, but local HTTP
capture/evaluation is not wired in yet.

## Packages

This repository is a pnpm monorepo. Published packages live under `packages/`.

| Package                                            | npm                                                          | Description                                            |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| [`dynobox`](./packages/cli)                        | [`dynobox`](https://www.npmjs.com/package/dynobox)           | CLI for loading configs and running local scenarios    |
| [`@dynobox/sdk`](./packages/sdk)                   | [`@dynobox/sdk`](https://www.npmjs.com/package/@dynobox/sdk) | SDK for authoring configs and compiling canonical IR   |
| [`@dynobox/runner-local`](./packages/runner-local) | Unpublished                                                  | Local runner for harness execution and tool assertions |
| [`@dynobox/evaluators`](./packages/evaluators)     | Unpublished                                                  | Assertion evaluators shared by runner code             |

`@dynobox/runner-local` and `@dynobox/evaluators` are private workspace packages. They are bundled into the published `dynobox` CLI instead of exposed as public npm dependencies.

## Development

Common root commands:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm check
```

Package-scoped examples:

```bash
pnpm --filter dynobox test
pnpm --filter @dynobox/sdk test
pnpm --filter dynobox... build
```

## Project Site

[dynobox.dev](https://dynobox.dev)

## License

Apache-2.0 for all code in this repository. See [LICENSE](./LICENSE).
