# Dynobox Docs

Dynobox is an early local test runner for agent and skill workflows. It lets you describe a task, run it through one or more agent harnesses, and assert on observable behavior such as tool usage, shell commands, files written in the sandbox, transcripts, and final messages.

Use these docs when evaluating whether Dynobox can cover a coworker's skill or agent workflow today.

## Start Here

- [Getting Started](./getting-started.md): install dependencies, run the examples, and create a first config.
- [Config Authoring](./config-authoring.md): the current `@dynobox/sdk` API and supported assertions.
- [CLI Reference](./cli.md): `dynobox run`, harness overrides, output modes, and exit behavior.

## Current Scope

Dynobox currently supports local execution through:

- Claude Code via the `claude` executable.
- OpenAI Codex via the `codex` executable.

It can assert:

- Whether harness tools were called or not called.
- Shell command content with `equals`, `includes`, `startsWith`, or `matches`.
- Ordered tool-call sequences.
- Files created or updated inside the scenario work directory.
- Harness transcript and final-message text.

HTTP endpoint declarations and HTTP assertions are available in the SDK, but HTTP traffic capture/evaluation is not wired into the local runner yet.

## Good Fits Today

Dynobox is useful now for checking whether a skill or agent workflow:

- Runs expected shell commands.
- Reads, writes, or edits expected files.
- Avoids prohibited tools or shell commands.
- Produces a final answer containing required text.
- Works similarly across Claude Code and Codex.
- Survives refactors or prompt changes by running repeatable scenarios.

## Not Yet Covered

The current local runner is not yet a full production eval platform. These areas are still in progress:

- HTTP request capture and HTTP assertion evaluation.
- Hosted or remote runner execution.
- Rich multi-iteration controls from authored configs.
- First-class docs site publishing from this repo.
