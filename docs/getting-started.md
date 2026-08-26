# Getting Started

This guide gets you from an empty project to one passing Dynobox run.

Dynobox tests live in `*.dyno.*` files. A dyno describes a prompt, optional
setup commands, one or more harnesses, and assertions about what the harness did
while completing the task.

## Prerequisites

- Node.js 22 or newer.
- At least one supported local harness:
  - `claude` for Claude Code.
  - `codex` for OpenAI Codex.
  - `opencode` for OpenCode.
  - `pi` for Pi.
  - `cursor-agent` for Cursor CLI.
  - `agy` 1.1.14 or newer for Google Antigravity CLI.

The selected harness must be installed, authenticated, and available on `PATH`.

## Install

Install the CLI:

```bash
npm install -g dynobox
```

Check that it is available:

```bash
dynobox --help
```

## Connect The CLI (Optional)

Dynobox has a web dashboard at [dash.dynobox.xyz](https://dash.dynobox.xyz).
Local runs do not require an account. Connect the CLI only when you want to save
runs to the dashboard:

```bash
dynobox login
```

Open the URL printed by the CLI, create a token, and paste it back into your
terminal. You can verify the saved identity with:

```bash
dynobox whoami
```

After authenticating, you can save a run summary with `dynobox run --save-run`.
Alternatively, set `DYNOBOX_UPLOAD_URL` to use your own endpoint without a
Dynobox token. Saved-run data is not redacted, so do not upload runs that may
contain secrets. See [Saving Runs](./cli.md#saving-runs) for payload and endpoint
details.

## Create Your First Dyno

Choose a starter harness that is installed and authenticated. Omitting
`--harness` selects Claude Code:

```bash
dynobox init                         # Claude Code (default)
dynobox init --harness codex         # OpenAI Codex
dynobox init --harness opencode      # OpenCode
dynobox init --harness pi            # Pi
dynobox init --harness cursor        # Cursor CLI
dynobox init --harness antigravity   # Google Antigravity CLI
```

Run one of the commands above. It writes `dynobox/example.dyno.mjs`, which you
can run with:

```bash
dynobox run
```

By default, `dynobox run` discovers every `*.dyno.{mjs,js,ts,mts,yaml,yml}`
file under the current directory.

Only run dynos you trust. JavaScript and TypeScript configs are imported, and
setup and verification commands execute on your machine. Each job receives a
fresh temporary work directory for file separation, but that directory is not a
security sandbox; processes can access the host according to their permissions.

## Choose A Harness

Each dyno can declare its own harness list. You can also override harnesses at
runtime. Select only harnesses installed and authenticated in the current
environment:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness opencode
dynobox run --harness pi
dynobox run --harness cursor
dynobox run --harness antigravity
dynobox run --harness claude-code,codex,opencode,pi,cursor,antigravity
```

If neither the config nor the CLI selects a harness, Dynobox defaults to
`claude-code`.

Repeat runs when you want a pass-rate signal instead of a single sample:

```bash
dynobox run --harness claude-code,codex,opencode,pi,cursor,antigravity --iterations 5
```

Iterations are chosen at runtime. The dyno still only describes what to test;
the CLI decides how many times to execute each selected scenario/harness pair.
Harness configurations for the same scenario run in parallel, while iterations
for each configuration run sequentially. Dynobox waits for all harnesses in the
current scenario before starting the next scenario.

## Author A Minimal Dyno

The example below asks the harness to inspect `package.json` with `cat`, checks
that the command was observed, verifies `package.json` was unchanged, and
confirms the final answer mentioned the test script.

```ts
import {artifact, command, defineDyno, finalMessage, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'package-script-check',
  harnesses: ['claude-code'],
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
        artifact.unchanged('package.json'),
        finalMessage.contains('test'),
      ],
    },
  ],
});
```

Prefer YAML? Use `dynobox init --yaml` and see [YAML
Configs](./config-authoring.md#yaml-configs). The [Config Authoring
reference](./config-authoring.md) covers every assertion type.

For larger fixtures, put files in a `fixtures/` directory next to a JavaScript
or TypeScript dyno that uses `defineDyno(...)`. Dynobox copies that directory
into each scenario work directory automatically unless the scenario sets its
own `fixtures` value.

## Run A Specific Path

`dynobox run [path]` accepts:

- No argument: discover dynos recursively under the current directory.
- Directory path: discover dynos recursively under that directory.
- File path: run one loadable Dynobox config file.

Examples:

```bash
dynobox run
dynobox run .agents/skills/
dynobox run my-skill.dyno.yaml
dynobox run dynobox.config.ts
```

See [`dynobox run [path]`](./cli.md#dynobox-run-path) for discovery exclusions,
supported extensions, and `dyno.config.json` options.

## Debug A Run

Use these flags while developing scenarios:

```bash
dynobox run --verbose
dynobox run --debug
dynobox run --reporter json
dynobox run --save-run
```

`--verbose` expands lifecycle and observed-command details. `--debug` also shows
temporary paths and writes available run artifacts. Use the JSON reporter for
automation and `--save-run` to upload a compact run summary. See [Output
Modes](./cli.md#output-modes) for the complete output and debug-file contract.

Dynobox uses harness-specific non-dangerous headless behavior by default. For
trusted local evals that intentionally need elevated or automatically approved
access, configure `permissionMode: 'dangerous'` in the dyno or pass:

```bash
dynobox run --permission-mode dangerous
```

The exact behavior is harness-specific. See the
[CLI harness requirements](./cli.md#harness-requirements) for every default and
dangerous-mode mapping.

## Next Steps

- Write more scenarios with [Config Authoring](./config-authoring.md).
- Add Dynobox to automation with [CI Integration](./ci.md).
- Check exact flags and output fields in the [CLI Reference](./cli.md).
- Use `dynobox run --save-run` to send a compact run summary to the dashboard or
  a custom `DYNOBOX_UPLOAD_URL` endpoint.
