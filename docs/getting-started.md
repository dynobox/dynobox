# Getting Started

Dynobox is a test framework for agent and skill workflows. You describe what an
agent should do in a `*.dyno.{mjs,yaml}` file, then `dynobox run` executes the
prompt against a local harness (Claude Code or Codex) and evaluates assertions
against the observed behavior.

## Prerequisites

- Node.js 22+.
- At least one local harness installed and authenticated:
  - `claude` for the Claude Code harness.
  - `codex` for the Codex harness.

Dynobox runs each scenario in a temporary work directory. Scenario `setup`
commands prepare the files the agent should operate on before the prompt runs.

## Install

```bash
npm install -g dynobox
```

Verify the install:

```bash
dynobox --help
```

## Scaffold A Starter Dyno

The fastest path from zero to a passing run:

```bash
dynobox init        # writes dynobox/example.dyno.mjs
dynobox run         # discovers and runs every *.dyno.* file under the cwd
```

`dynobox init` accepts:

- `--yaml` — generate `dynobox/example.dyno.yaml` instead of MJS.
- `--harness <id>` — pin the starter harness (default `claude-code`).
- `--force` — overwrite an existing starter file.

## Discovery

`dynobox run [path]` accepts:

- _no argument_ — discover recursively under the current directory.
- a directory path — discover recursively under that directory.
- a file path — run that single file (works for any `.mjs`/`.js`/`.ts`/`.yaml`/`.yml`,
  not just `*.dyno.*`).

Discovery globs `**/*.dyno.{mjs,cjs,js,ts,mts,cts,yaml,yml}` and skips
`node_modules`, `dist`, `build`, `coverage`, `.git`, `.dynobox`, `.next`, and
`.cache` by default.

## Pick A Harness

Each authored dyno declares its own harness list. To override at runtime:

```bash
dynobox run                       # uses harnesses from each file
dynobox run --harness claude-code
dynobox run --harness codex
dynobox run --harness claude-code,codex
```

If you omit `--harness` and a file does not list harnesses, Dynobox defaults to
`claude-code`.

## Author A Dyno

A dyno file exports a `defineDyno(...)` (TypeScript / JavaScript) or is a YAML
document with the same shape. The example below tests a skill that should
inspect `package.json` without modifying files.

**TypeScript form** (`my-skill.dyno.mjs`):

```ts
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

**YAML form** (`my-skill.dyno.yaml`):

```yaml
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
        {
          "name": "fixture",
          "scripts": {"test": "vitest run"}
        }
        JSON
    assertions:
      - kind: tool.called
        toolKind: shell
        matcher:
          includes: package.json
      - kind: tool.notCalled
        toolKind: edit_file
      - kind: artifact.contains
        path: package.json
        text: vitest run
      - kind: finalMessage.contains
        text: test
```

See [`docs/config-authoring.md`](./config-authoring.md) for the full assertion
reference and the helper-to-`kind` mapping used in YAML.

## Run And Debug

```bash
dynobox run                # run every discovered file
dynobox run examples/      # run a specific directory
dynobox run my-skill.dyno.mjs   # run one file
dynobox run --verbose      # expand passing scenarios
dynobox run --debug        # include work-dir paths and debug logs
```

`--debug` writes per-job logs (`dynobox-transcript.log`,
`dynobox-chat-history.jsonl`, `dynobox-tool-events.json`) into each scenario's
work directory.

Dynobox uses secure harness defaults. To opt into a full-access run, either set
`permissionMode: 'dangerous'` on the harness in your dyno file, or pass:

```bash
dynobox run --permission-mode dangerous
```

## Interpreting Results

Each scenario expands into one job per selected harness. A passing job means
setup completed, the harness exited successfully, and every assertion passed.

Common failure causes:

- The harness executable is missing or not authenticated.
- A setup command failed before the prompt ran.
- The agent did not call the expected tool.
- A shell matcher was too strict for the harness's actual command.
- An artifact assertion used an absolute path or tried to leave the work
  directory.

## Developing Dynobox Itself

If you're hacking on the CLI/SDK from a checkout rather than the published
package:

```bash
pnpm install
pnpm build
pnpm test
node packages/cli/dist/bin.js run examples/local-observability
```
