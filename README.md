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

Install and build from the repository root:

```bash
pnpm install
pnpm build
```

Run the local smoke-test config with a specific harness:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness claude-code
```

Or run it with Codex:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness codex
```

The selected harness executable must already be installed, authenticated, and available on `PATH`.

## Example Config

```ts
import {artifact, defineDyno, finalMessage, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'package-script-skill',
  harnesses: ['claude-code'],
  scenarios: [
    {
      name: 'detects test script',
      setup: [
        `cat > package.json <<'JSON'
{
  "name": "fixture",
  "scripts": {
    "test": "vitest run"
  }
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

See [Getting Started](./docs/getting-started.md) for a full walkthrough.

## Documentation

- [Docs index](./docs/README.md)
- [Getting Started](./docs/getting-started.md)
- [Config Authoring](./docs/config-authoring.md)
- [CLI Reference](./docs/cli.md)

## Current Capabilities

- Author dynos with `@dynobox/sdk` helpers: `defineDyno`, `defineScenario`, `tool`, `skill`, `artifact`, `transcript`, `finalMessage`, `sequence`, `http`, and `dyno`.
- Run `dynobox run <config>` locally against Claude Code, Codex, or both.
- Override harnesses at runtime with `--harness claude-code`, `--harness codex`, or comma-separated values.
- Assert tool calls with `tool.called(...)` and `tool.notCalled(...)`.
- Assert skill instruction loading with `skill.invoked(...)`.
- Match shell commands with `equals`, `includes`, `startsWith`, or `matches`.
- Assert ordered tool-call sequences with `sequence.inOrder(...)`.
- Assert work-directory artifacts with `artifact.exists(...)` and `artifact.contains(...)`.
- Assert harness transcript and final response text with `transcript.contains(...)` and `finalMessage.contains(...)`.
- Stream live progress and tool events in interactive terminals.
- Use default, `--quiet`, `--verbose`, and `--debug` output modes.

HTTP endpoint declarations and HTTP assertions exist in the SDK, but local HTTP capture/evaluation is not wired in yet.

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
