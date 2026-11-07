# Mock MCP services

Declare `mcpMocks` on a scenario to provide MCP tools with fixed responses.
Dynobox starts HTTP MCP endpoints and supplies their configuration to the
harness. You do not need real service URLs, accounts, or MCP credentials for
the mocked tools. Your harness still needs its normal model authentication.

Mocks replace only the servers you declare. Depending on the harness, other
MCP servers, plugins, and connectors from your profile can stay real during the
run. See [Other MCP servers](#other-mcp-servers).

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
configuration. A harness that keeps your other MCP servers loads them as it
normally would, and the agent can call them with real side effects.

`mcp.called` and `mcp.notCalled` check only calls received by mocks. Calls to
real servers are not checked, and other servers can influence the agent, so
results can depend on the loaded profile.

For a run that cannot reach real services, mock every server the scenario
could use, or run the harness with a dedicated profile that has no other MCP
servers. A fresh profile also needs its own model login.

## Availability and reporting

MCP mocks run locally. Each adapter enforces its supported CLI version;
unsupported versions and configuration conflicts fail explicitly.

| Harness | Minimum CLI | Other MCP servers |
| --- | --- | --- |
| Claude Code | 2.1.263 | Remain available. Declared targets are replaced for this run. |
| Codex | 0.153.4 | Remain available. Declared HTTP targets are replaced for this run. |
| OpenCode | 2.2.5 (2.x) | Remain available. Declared targets are replaced for this run. |
| Pi | 0.86.0 | Excluded by the current adapter. |
| Antigravity | 1.2.11 | Excluded by the current adapter. |
| Cursor | — | MCP mocking unavailable. |

The fixture schema and call assertions are the same across supported harnesses.

Codex replaces HTTP targets; a same-named stdio target fails explicitly. It
retains normal configuration, model login, plugins, and skills. The agent sees
private native server names; assertions, callbacks, and reports keep the logical
names declared in `mcpMocks`. Skills that refer to exact native tool namespaces
must account for this difference.

OpenCode retains normal profiles, plugins, model authentication, and skills.
Managed targets that cannot be replaced, overlapping tool namespaces, and
declared mocks that fail discovery stop the job before its task starts.

Mock arguments, response payloads, and temporary connection URLs are omitted
from normal reports. `--debug` keeps harness output in local debug files.
MCP mock runs currently cannot use `--save-run`.
