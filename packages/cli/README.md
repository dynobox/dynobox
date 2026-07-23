# dynobox

Cross-harness testing for multi-step agent and skill workflows.

Dynobox runs agent scenarios through local harnesses such as Claude Code, Codex,
and OpenCode, captures observable behavior, and evaluates assertions against
what actually happened.

- Site: [dynobox.xyz](https://dynobox.xyz)
- Docs: [docs.dynobox.xyz](https://docs.dynobox.xyz)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Install

```bash
npm install -g dynobox
```

Dynobox requires Node.js 22 or later. The selected harness executable must
already be installed, authenticated, and available on `PATH`.

## Quick Start

Create a starter dyno file, then run it:

```bash
dynobox init                         # Claude Code (default)
dynobox init --harness codex         # OpenAI Codex
dynobox init --harness opencode      # OpenCode
dynobox discover
dynobox run
```

Run one `init` command for a harness that is installed and authenticated.
`dynobox init` writes `dynobox/example.dyno.mjs` by default. `dynobox run` with
no argument discovers `*.dyno.{mjs,js,ts,mts,yaml,yml}` files recursively under
the current directory. `dynobox discover` prints the same file list without
loading configs or running harnesses.

Only run dynos you trust. JavaScript and TypeScript configs are imported, and
setup and verification commands execute on your machine. Temporary work
directories separate job files, but they are not security sandboxes; processes
can access the host according to their permissions.

Scope a run to a directory or file:

```bash
dynobox run .agents/skills/
dynobox run my-skill.dyno.yaml
```

Pick a harness at runtime when needed:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness opencode
dynobox run --harness claude-code,codex,opencode
```

Repeat each selected scenario/harness pair when you want a pass-rate signal:

```bash
dynobox run --harness claude-code,codex,opencode --iterations 5
```

## What You Can Assert

Dynobox supports assertions for:

- Tool calls with `tool.called(...)` and `tool.notCalled(...)`.
- Normalized commands with `command.called(...)` and `command.notCalled(...)`.
- File tool path matchers such as
  `tool.called('read_file', {path: 'package.json'})`.
- Ordered behavior with `sequence.inOrder(...)` and alternatives with
  `anyOf(...)`.
- Skill instruction file references.
- Work-directory artifacts, including unchanged and absent files.
- Harness transcript and final response text.
- HTTP requests from local child-process tools that honor proxy environment
  variables.
- Post-run executable checks with `verify.command(...)`.

## Common Run Flags

- `--quiet`: compact discovery, dots-and-failures, and summary output for CI.
- `--verbose`: expand every job with phase rows and assertion details.
- `--debug`: include verbose details plus work directory, artifact paths, and
  debug log paths.
- `--reporter json`: emit newline-delimited JSON reports.
- `--scenario <pattern>`: run only matching scenarios.
- `--iterations <count>`: repeat each selected scenario/harness pair.
- `--permission-mode default|dangerous`: override harness permission behavior.
- `--save-run`: upload a compact dashboard summary when authenticated.

## Auth

Use `dynobox login` to paste a dashboard-generated CLI token into local config,
then `dynobox whoami` to verify the saved identity. `dynobox logout` removes the
saved token. CLI tokens expire after 24 hours; when a token expires, run
`dynobox login` again to re-authenticate.

Authenticated runs can upload a compact dashboard summary with
`dynobox run --save-run`. You can also set `DYNOBOX_TOKEN` instead of using the
saved local config.

Saved-run data is length-capped but not redacted. All jobs can include authored
assertion data and matched evidence such as requested endpoint URLs, tool
commands, and verification output. Failed jobs can additionally include command
or harness diagnostics. Do not use `--save-run` when those values may contain
secrets.

## Documentation

- [Getting Started](https://docs.dynobox.xyz/getting-started)
- [Config Authoring](https://docs.dynobox.xyz/config-authoring)
- [CLI Reference](https://docs.dynobox.xyz/cli)
