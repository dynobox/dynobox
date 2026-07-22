# Dynobox Docs

Dynobox is a local test runner for agent and skill workflows. You describe a
task, choose one or more local agent harnesses, and assert on observable
behavior such as tool calls, shell commands, files in the scenario work
directory, transcripts, HTTP requests, and final messages.

Dynobox is useful when you want repeatable checks for agent behavior before
shipping a prompt, skill, or workflow change.

## Start Here

- [Getting Started](./getting-started.md): install the CLI, scaffold a dyno,
  and run your first scenario.
- [Agent Skills](./agent-skills.md): install AI agent skills for creating dynos
  and debugging failed runs.
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
for reviewing or sharing the saved run. Run owners can compare compatible jobs
across saved runs to inspect assertion outcome and evidence changes.

Saved-run data is length-capped but not redacted. Failed-job diagnostics can
include command or harness output, requested endpoint URLs, and tool commands.
Do not use `--save-run` when those values may contain secrets.

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

Dynobox runs each scenario in a fresh temporary work directory. Setup commands
create the fixture, the selected harness performs the task, and assertions
evaluate what happened.

Work directories separate job files but are not security sandboxes. Dynos are
trusted code: JavaScript and TypeScript configs are imported, and setup,
verification, and harness processes may access the host according to their
permissions.

You can assert:

- Tool calls, including path-aware file tool calls and raw shell escape hatches.
- Normalized observed shell commands with `command.called(...)` and
  `command.notCalled(...)`.
- Skill instruction file references with `skill.referenced(...)`.
- Ordered behavior sequences and valid alternatives with `sequence.inOrder(...)`
  and `anyOf(...)`, including nested `verify.command(...)` branches.
- Work-directory artifacts with `artifact.exists(...)`,
  `artifact.notExists(...)`, `artifact.contains(...)`, and
  `artifact.unchanged(...)`.
- Harness transcript and final-message text.
- HTTP requests made by local child-process tools that honor proxy environment
  variables.
- Post-harness verification commands with `verify.command(...)`.

Use `dynobox run --iterations <count>` to repeat every selected
scenario/harness pair and render inline pass-rate sparklines such as
`.F...`.

## Supported Harnesses

Dynobox currently runs local scenarios through:

- Claude Code via the `claude` executable.
- OpenAI Codex via the `codex` executable.
- OpenCode via the `opencode` executable.

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
