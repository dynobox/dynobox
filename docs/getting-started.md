# Getting Started

This guide assumes you are checking out the repository and want to see whether Dynobox can test your own skill or agent workflow.

## Prerequisites

- Node.js compatible with the repo toolchain.
- `pnpm` via the package manager declared in `package.json`.
- At least one local harness installed and authenticated:
  - `claude` for the Claude Code harness.
  - `codex` for the Codex harness.

Dynobox runs scenarios in temporary work directories. Scenario `setup` commands create the files the agent should operate on before the harness prompt runs.

## Install And Build

From the repository root:

```bash
pnpm install
pnpm build
```

Run the test suite if you want to verify the checkout:

```bash
pnpm test
```

## Run The Local Smoke Test

The fastest example is `examples/local-observability/dynobox.config.ts`.

```bash
pnpm --filter dynobox build
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness claude-code
```

Use Codex instead if that is the harness you have installed:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness codex
```

Run both harnesses with a comma-separated override:

```bash
node packages/cli/dist/bin.js run examples/local-observability/dynobox.config.ts --harness claude-code,codex
```

If you omit `--harness`, Dynobox uses the harness list from the config. When a config does not specify harnesses, it defaults to `claude-code`.

## Create A Skill-Oriented Config

A Dynobox config is a TypeScript module with a default export from `defineDyno`. This example tests a hypothetical skill that should inspect package scripts without modifying files.

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

Save the file anywhere in the repo, for example `tmp/package-script.dynobox.config.ts`, then run it:

```bash
node packages/cli/dist/bin.js run tmp/package-script.dynobox.config.ts --harness claude-code --debug
```

Use `--debug` when developing a scenario. It prints the temporary work directory and writes debug logs such as `dynobox-transcript.log`, `dynobox-chat-history.jsonl`, and `dynobox-tool-events.json` inside each job work directory.

Dynobox uses secure harness defaults. If a trusted local eval needs full access or non-interactive approval bypasses, opt in explicitly:

```bash
node packages/cli/dist/bin.js run tmp/package-script.dynobox.config.ts --permission-mode dangerous
```

You can also set `permissionMode: 'dangerous'` on a specific harness entry in a config.

## Interpreting Results

Each scenario expands into one job per selected harness. A passing job means setup completed, the harness exited successfully, and all assertions passed.

Common failure causes:

- The harness executable is missing or not authenticated.
- A setup command failed before the prompt ran.
- The agent did not call the expected tool.
- A shell matcher was too strict for the harness's actual command.
- An artifact assertion used an absolute path or tried to leave the work directory.
