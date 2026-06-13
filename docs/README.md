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
- [CI Integration](./ci.md): temporary GitHub Actions pattern from the
  [`dynobox/skills`](https://github.com/dynobox/skills) repo.

## Dynobox Dashboard

The web dashboard lives at [dash.dynobox.xyz](https://dash.dynobox.xyz). It is
where you create short-lived CLI tokens for authenticated Dynobox commands. Use
`dynobox login`, open the dashboard URL it prints, create a token, and paste that
token back into the CLI.

Authenticated CLI runs can upload compact summaries with
`dynobox run --save-run`. When an upload succeeds, the CLI prints a dashboard URL
for reviewing or sharing the saved run.

## Agent Resources

The docs site publishes agent-oriented entry points for retrieval and indexing:

- [`llms.txt`](https://docs.dynobox.xyz/llms.txt): concise docs map with
  canonical HTML, markdown, source, package, and command references.
- [`llms-full.txt`](https://docs.dynobox.xyz/llms-full.txt): the full public
  docs corpus as one plain-text file.
- [`docs-index.json`](https://docs.dynobox.xyz/docs-index.json):
  machine-readable page metadata, topics, headings, and canonical URLs.
- Raw markdown pages such as
  [`getting-started.md`](https://docs.dynobox.xyz/getting-started.md) for
  direct ingestion without HTML parsing.

## What Dynobox Tests

Dynobox runs each scenario in an isolated temporary work directory. Setup
commands create the fixture, the selected harness performs the task, and
assertions evaluate what happened.

You can assert:

- Tool calls, including expected and prohibited shell commands or path-aware
  file tool calls.
- Skill instruction loading with `skill.invoked(...)`.
- Ordered tool-call sequences.
- Files present inside the scenario work directory.
- Harness transcript and final-message text.
- HTTP requests made by local child-process tools that honor proxy environment
  variables.

Use `dynobox run --iterations <count>` to repeat every selected
scenario/harness pair and render sparkline pass-rate matrix cells such as
`.F...`.

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
- YAML with the same `type`-discriminated assertion objects that SDK helpers
  return.

JavaScript and TypeScript dynos using `defineDyno(...)` automatically attach an
adjacent `fixtures/` directory to scenarios that do not set `fixtures`
explicitly. Dynos authored under `.agents/skills/<name>/` or
`.claude/skills/<name>/` also automatically copy that skill's `SKILL.md` into
each scenario work directory.

CommonJS config files (`.cjs` and `.cts`) are not supported because the SDK is
ESM-only.

## Current Limits

Dynobox is under active development and is currently focused on local
execution. These areas are not complete yet:

- HTTP capture for harness-native web tools and binaries that ignore proxy/CA
  environment variables.
- Hosted or remote runner execution.
- Richer hosted run comparison and reporting flows.
