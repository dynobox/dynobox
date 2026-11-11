# Mock MCP services

Declare `mcpMocks` on a scenario to provide MCP tools with fixed responses.
Dynobox starts HTTP MCP endpoints and supplies their configuration to the
harness. You do not need real service URLs, accounts, or MCP credentials for
the mocked tools. Your harness still needs its normal model authentication.

Mocks replace only the servers you declare. Other MCP servers, plugins, and
connectors from your profile stay real during the run. See
[Other MCP servers](#other-mcp-servers).

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
tools it exposes. Use the configured unscoped server name when replacing a
service. Plugins can give their servers different, scoped names. Dynobox
grants permission for the declared mock tools automatically.

Claude-generated plugin and connector namespaces reserve the server prefixes
`plugin_` and `claude_ai_`; use an unscoped server name for a Claude mock.
Claude joins server and tool names with `__`, so Claude mock server and tool
names cannot contain `__`. Dynobox rejects these names before launching Claude
and rejects other detected ambiguous native identities during readiness
validation. Plugin and connector servers stay real and remain subject to
normal harness permissions.

`mcp.called` checks calls received by the mock, including matching arguments
when `input` is provided. `mcp.notCalled` requires a usable mock environment and
a completed run. A disconnected or refused mock cannot make a negative
assertion pass. Assertions refer to logical server/tool names on every harness.

## Other MCP servers

Dynobox runs your harness with your normal profile and does not edit its
configuration. The harness loads your other MCP servers as it normally would,
and the agent can call them with real side effects.

`mcp.called` and `mcp.notCalled` check only calls received by mocks. Calls to
real servers are not checked, and other servers can influence the agent, so
results can depend on the loaded profile.

For a run that cannot reach real services, mock every server the scenario
could use, or run the harness with a dedicated profile that has no other MCP
servers. A fresh profile also needs its own model login.

## Availability

MCP mocks run locally. Each harness enforces its minimum CLI version.

| Harness | Minimum CLI |
| --- | --- |
| Antigravity | 1.5.2 |
| Claude Code | 2.1.263 |
| Codex | 0.153.4 |
| Cursor | 2026.10.22 |
| OpenCode | 2.2.5 (2.x) |
| Pi | 1.5.0 (1.x) |

### Antigravity

Set the model with the scenario's `model`, not `extraArgs`. Jobs that share an
Antigravity profile run one at a time.

### Codex

The agent sees each mock under a name with a `_dynobox` suffix, for example
`mcp__linear_dynobox__get_issue`. Assertions and reports still use the names
declared in `mcpMocks`. Skills that name exact MCP tools must allow for the
suffix.

### Cursor

As with Codex, the agent sees each mock under a name with a `_dynobox` suffix,
for example `plugin-dynobox-linear_dynobox`. For plugin servers, use the full
server identifier that Cursor shows.

## Failures and reporting

A job fails, instead of letting `mcp.notCalled` pass by accident, when:

- A real stdio server has the same name as a mock. Antigravity, Codex, Cursor,
  and Pi replace only HTTP servers.
- A permission rule denies a mock tool.
- The harness never discovers a declared mock.

Reports omit mock arguments, responses, and connection URLs. `--debug` keeps
harness output in local debug files.
