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
Alternatively, set `DYNOBOX_UPLOAD_URL` to post the same schema v4 JSON payload
to your own endpoint without a Dynobox token or authorization header.

Saved-run data is length-capped but not redacted. It includes available Git
commit, branch, dirty-state, and configured user name/email metadata from the
directory where the CLI was started. All jobs can include authored assertion
data and matched evidence such as requested endpoint URLs, tool commands, and
verification output. Failed jobs can additionally include command or harness
diagnostics. Do not use `--save-run` when those values may contain secrets. Local
CLI output and `--reporter json` remain available without authentication.

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
runtime:

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

The same dyno can be authored in YAML:

```yaml
name: package-script-check
harnesses:
  - claude-code
scenarios:
  - name: detects test script
    prompt: >-
      Use cat package.json and tell me whether this project has a test script.
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
        type: command.called
        executable: cat
        command:
          args:
            - package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.unchanged
        path: package.json
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
dynobox run .agents/skills/
dynobox run my-skill.dyno.yaml
dynobox run dynobox.config.ts
```

Directory discovery skips dot directories by default, but explicitly includes
`.agents` and `.claude` skill directories. If you pass a hidden directory as the
path, Dynobox searches that directory. Discovery also skips `node_modules`,
`dist`, `build`, `coverage`, `.git`, `.dynobox`, `.next`, and `.cache`.
Explicit file paths do not need to match the `*.dyno.*` naming pattern, but they
still need to be loadable JavaScript, TypeScript, or YAML Dynobox configs. `.cjs`
and `.cts` configs are not supported.

To skip additional generated directories, add `dyno.config.json` to your
project root:

```json
{
  "ignoredDirectories": ["generated", "vendor/examples"]
}
```

`dynobox run`, `dynobox validate`, and `dynobox discover` read
`dyno.config.json` from the directory you run them in (no upward walk), so run
them from your project root. Pass `--config <path>` to use a specific JSON config
file from anywhere. `ignoredDirectories` entries are relative to the config file,
so a project-root config can ignore project-root directories.

## Debug A Run

Use these flags while developing scenarios:

```bash
dynobox run --verbose
dynobox run --debug
dynobox run --reporter json
dynobox run --save-run
```

`--verbose` expands every job with setup, harness, and assertion phase rows. It
also lists parsed command segments when command assertions are present. For
scenarios using experimental CLI mocks, it lists configured executables and
recorded calls.

`--debug` includes everything from `--verbose`, prints each job's temporary work
directory and artifact paths, and writes debug logs when data is available:

- `dynobox-transcript.log`
- `dynobox-chat-history.jsonl`
- `dynobox-tool-events.json`
- `dynobox-cli-mocks.json`
- `dynobox-stderr.log`

`dynobox-cli-mocks.json` records each completed mock call, including arguments,
working directory, output, and exit code, but not child environment values.

Dynobox uses each harness's normal permission behavior by default. For trusted
local evals that intentionally need elevated or automatically approved access,
configure `permissionMode: 'dangerous'` in the dyno or pass:

```bash
dynobox run --permission-mode dangerous
```

The exact behavior is harness-specific. OpenCode's dangerous mode adds `--auto`
but still enforces explicit deny rules.

## Next Steps

- Write more scenarios with [Config Authoring](./config-authoring.md).
- Add Dynobox to automation with [CI Integration](./ci.md).
- Check exact flags and output fields in the [CLI Reference](./cli.md).
- Use `dynobox run --save-run` to send a compact run summary to the dashboard or
  a custom `DYNOBOX_UPLOAD_URL` endpoint.
