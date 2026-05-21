# Dynobox Docs

Dynobox is a local test runner for agent and skill workflows. You describe a
task, choose one or more local agent harnesses, and assert on observable
behavior such as tool calls, shell commands, files in the sandbox, transcripts,
HTTP requests, and final messages.

Dynobox is useful when you want repeatable checks for agent behavior before
shipping a prompt, skill, or workflow change.

## Start Here

- [Getting Started](./getting-started.md): install the CLI, scaffold a dyno,
  and run your first scenario.
- [Config Authoring](./config-authoring.md): write JavaScript, TypeScript, or
  YAML dynos with the `@dynobox/sdk` helpers.
- [CLI Reference](./cli.md): commands, flags, output modes, JSON reports, and
  exit behavior.
- [CI Integration](./ci.md): run Dynobox in GitHub Actions and publish JSON
  reports as build artifacts.

## What Dynobox Tests

Dynobox runs each scenario in an isolated temporary work directory. Setup
commands create the fixture, the selected harness performs the task, and
assertions evaluate what happened.

You can assert:

- Tool calls, including expected and prohibited shell commands.
- Skill instruction loading with `skill.invoked(...)`.
- Ordered tool-call sequences.
- Files present inside the scenario work directory.
- Harness transcript and final-message text.
- HTTP requests made by local child-process tools that honor proxy environment
  variables.

## Supported Harnesses

Dynobox currently runs local scenarios through:

- Claude Code via the `claude` executable.
- OpenAI Codex via the `codex` executable.

Each harness must already be installed, authenticated, and available on
`PATH`.

## Supported Config Formats

Dynobox discovers `*.dyno.{mjs,js,ts,mts,yaml,yml}` files recursively when you
run a directory. Explicit file paths can use non-`*.dyno.*` names, such as
`dynobox.config.ts`, as long as they are loadable Dynobox configs.

Supported authoring formats:

- TypeScript or JavaScript with `defineDyno(...)` from `@dynobox/sdk`.
- YAML with `kind`-discriminated assertion objects.

CommonJS config files (`.cjs` and `.cts`) are not supported because the SDK is
ESM-only.

## Current Limits

Dynobox is under active development and is currently focused on local
execution. These areas are not complete yet:

- HTTP capture for harness-native web tools and binaries that ignore proxy/CA
  environment variables.
- Hosted or remote runner execution.
- Rich multi-iteration controls from authored configs.
