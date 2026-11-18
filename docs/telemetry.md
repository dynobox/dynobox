# Telemetry

The Dynobox CLI sends anonymous usage data so we can see which harnesses and
commands people use, how often runs fail, and where the time goes. It is on by
default, off in CI, and easy to turn off.

## What Is Sent

The first time a command would send data, the CLI prints a notice and creates
a random install ID in `~/.dynobox/telemetry.json`. After that, each `run`,
`validate`, `discover`, `init`, `login`, `logout`, and `whoami` sends one batch
with:

- **Context**: the install ID, CLI version, OS, CPU architecture, Node.js
  version, and whether `CI` is `1` or `true`.
- **Command**: the command name, exit code, duration, an error category such as
  `config` or `auth`, and whether this was the first command for the install.
- **Run** (for `dynobox run`): counts of dynos, scenarios, jobs, and
  iterations, whether the run passed, the config formats (`js`, `ts`, `yaml`),
  and which features were used (`save_run`, `cli_mocks`, `mcp_mocks`, `http`).
- **Harness runs** (for `dynobox run`, one per harness and model): the harness
  ID and version, the model name, job counts by outcome, total job time, and
  the number of tool calls Dynobox could not classify.

The run ID in these events is random and only links them to each other. It is
not the ID of a run saved with `--save-run`.

## What Is Never Sent

Prompts, transcripts, assertions, file paths, dyno and scenario names, target
names, repository names, Git metadata, environment variables, tokens, and your
Dynobox account identity.

## Turning It Off

Any of these turns telemetry off:

```bash
dynobox telemetry disable   # saved in ~/.dynobox/telemetry.json
export DYNOBOX_TELEMETRY=0
export DO_NOT_TRACK=1
```

Telemetry is also off when `CI` is `1` or `true`. Set `DYNOBOX_TELEMETRY=1` to
send it from CI.

The variables accept only `1` or `true` for on and `0` or `false` for off, in
any case. Any other value, such as `yes`, `on`, or `off`, is ignored, so use
`DYNOBOX_TELEMETRY=0`, not `DYNOBOX_TELEMETRY=off`.

Settings apply in this order: `DO_NOT_TRACK`, `DYNOBOX_TELEMETRY`,
`dynobox telemetry enable|disable`, then the CI default.

If `~/.dynobox/telemetry.json` cannot be read, or `enabled` in it is not
`true` or `false`, telemetry stays off, each command prints a warning, and the
file is left as is. Fix it or run `dynobox telemetry enable|disable` to replace
it.

`dynobox telemetry` (or `dynobox telemetry status`) shows whether telemetry is
on, what decided it, and your install ID.

## Seeing What Is Sent

Set `DYNOBOX_TELEMETRY_DEBUG=1` to print each batch to stderr instead of
sending it:

```bash
DYNOBOX_TELEMETRY_DEBUG=1 dynobox run
```

The schema is `TelemetryBatch` in
[`packages/run-schema/src/telemetry.ts`](https://github.com/dynobox/dynobox/blob/main/packages/run-schema/src/telemetry.ts).

Sending waits at most 1.5 seconds when a command finishes. A failed send is
ignored and never changes the command's output or exit code.
