# Mock MCP services

Declare `mcpMocks` on a scenario to provide MCP tools with fixed responses.
Dynobox starts HTTP MCP endpoints and supplies their configuration to the
harness. You do not need real service URLs, accounts, or MCP credentials for
the mocked tools. Your harness still needs its normal model authentication.

```yaml
name: Issue lookup
harnesses: [claude-code]
scenarios:
  - name: Read an issue
    prompt: Read issue DYNO-1 using Linear. Do not modify it.
    mcpMocks:
      linear:
        tools:
          get_issue:
            description: Read an issue by ID.
            inputSchema:
              type: object
              properties:
                id: {type: string}
              required: [id]
            response:
              content:
                - type: text
                  text: 'DYNO-1: Fix login'
          save_issue:
            description: Save an issue.
            inputSchema: {type: object}
            response:
              content: []
    assertions:
      - type: mcp.called
        server: linear
        tool: get_issue
        input: {id: DYNO-1}
      - type: mcp.notCalled
        server: linear
        tool: save_issue
```

The server key (`linear`) identifies the MCP server; tool keys identify the
tools it exposes. Use the exact effective server identity when replacing a
configured service. Plugins can give their servers different, scoped names.
Dynobox grants permission for the declared mock tools automatically.

`mcp.called` checks calls received by the mock, including matching arguments
when `input` is provided. `mcp.notCalled` requires a usable mock environment and
a completed run. A disconnected or refused mock cannot make a negative
assertion pass. Assertions refer to logical server/tool names on every harness.

## Other MCP servers

When an adapter permits other MCP servers, Dynobox warns before setup or
harness startup and asks once for the whole invocation:

```text
MCP mocks replace only the declared servers. Other MCPs remain real and may be used during this run.
claude-code: other configured MCPs: "github", "slack".
Continue? [Y/n]
```

Enter accepts; `n`, EOF, or Ctrl-C cancels. Warnings and prompts go to stderr,
so `--reporter json` stdout remains machine-readable.

The inventory reads stable profile configuration before a job workspace
exists; it does not connect to servers or execute commands. Project files,
setup-generated configuration, plugins, and managed configuration can make
it incomplete. In that case Dynobox says that additional MCPs may
load rather than claiming the list is exhaustive. Other servers can influence
the agent, so results can depend on the loaded profile. User configuration is
not edited.

For CI and other noninteractive runs, explicitly permit other servers:

```sh
npx dynobox run --allow-unmocked-mcp
```

The flag skips the question and retains the warning. Without it, a run that
may load other MCPs stops with an actionable error. Adapters that guarantee
only mocks can load do not require confirmation. Ordinary runs without
`mcpMocks` are unaffected.

Programmatic `runJob` callers use `allowUnmockedMcp: true` to grant the same
permission. Missing consent fails before workspace creation or setup. Terminal
prompts belong to the CLI, not to harness adapters.

## Availability and reporting

MCP mocks currently run locally with Claude Code, Codex, OpenCode, Pi, and
Antigravity. Cursor MCP mocking is unavailable until its runtime replacement
and evidence checks are verified. Each adapter enforces its supported CLI
version. Unsupported versions and configuration conflicts fail explicitly.

Mock arguments, response payloads, and temporary connection URLs are omitted
from normal reports. `--debug` keeps harness output in local debug files.
MCP mock runs currently cannot use `--save-run`.
