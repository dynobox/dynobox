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

## Connect The CLI

Dynobox has a web dashboard at [dash.dynobox.xyz](https://dash.dynobox.xyz).
Today, the dashboard is used to create short-lived CLI tokens. Run:

```bash
dynobox login
```

Open the URL printed by the CLI, create a token, and paste it back into your
terminal. You can verify the saved identity with:

```bash
dynobox whoami
```

Saved runs are coming soon. For now, local CLI output and `--reporter json` are
the primary ways to inspect and preserve run results.

## Create Your First Dyno

Use `dynobox init` to scaffold a starter scenario:

```bash
dynobox init
```

This writes `dynobox/example.dyno.mjs`. Run it with:

```bash
dynobox run
```

By default, `dynobox run` discovers every `*.dyno.{mjs,js,ts,mts,yaml,yml}`
file under the current directory.

## Choose A Harness

Each dyno can declare its own harness list. You can also override harnesses at
runtime:

```bash
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
```

If neither the config nor the CLI selects a harness, Dynobox defaults to
`claude-code`.

Repeat runs when you want a pass-rate signal instead of a single sample:

```bash
dynobox run --harness claude-code,codex --iterations 5
```

Iterations are chosen at runtime. The dyno still only describes what to test;
the CLI decides how many times to execute each selected scenario/harness pair.

## Author A Minimal Dyno

The example below asks the harness to inspect `package.json` and checks that it
used a shell command, did not edit files, and mentioned the test script in the
final answer.

```ts
import {artifact, defineDyno, finalMessage, tool} from '@dynobox/sdk';

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

The same dyno can be authored in YAML:

```yaml
name: package-script-check
harnesses:
  - claude-code
scenarios:
  - name: detects test script
    prompt: >-
      Inspect package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {
          "name": "fixture",
          "scripts": {"test": "vitest run"}
        }
        JSON
    assertions:
      - label: reads package.json
        type: tool.called
        tool: shell
        command:
          includes: package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: vitest run
      - type: finalMessage.contains
        text: test
```

See [Config Authoring](./config-authoring.md) for the full assertion reference.

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
dynobox run examples/local-observability
dynobox run my-skill.dyno.yaml
dynobox run dynobox.config.ts
```

Directory discovery skips hidden entries, `node_modules`, `dist`, `build`,
`coverage`, `.git`, `.dynobox`, `.next`, and `.cache`. Explicit file paths do
not need to match the `*.dyno.*` naming pattern, but they still need to be
loadable JavaScript, TypeScript, or YAML Dynobox configs. `.cjs` and `.cts`
configs are not supported.

## Debug A Run

Use these flags while developing scenarios:

```bash
dynobox run --verbose
dynobox run --debug
dynobox run --reporter json
```

`--debug` includes each job's temporary work directory and writes debug logs
when data is available:

- `dynobox-transcript.log`
- `dynobox-chat-history.jsonl`
- `dynobox-tool-events.json`
- `dynobox-stderr.log`

Dynobox uses each harness's normal permission behavior by default. For trusted
local evals that intentionally need full access, configure
`permissionMode: 'dangerous'` in the dyno or pass:

```bash
dynobox run --permission-mode dangerous
```

## Next Steps

- Write more scenarios with [Config Authoring](./config-authoring.md).
- Add Dynobox to automation with [CI Integration](./ci.md).
- Check exact flags and output fields in the [CLI Reference](./cli.md).
- Watch [dash.dynobox.xyz](https://dash.dynobox.xyz) for saved run history as it
  rolls out.
