import {
  defineDyno,
  finalMessage,
  mcp,
  type ScenarioMcpMocks,
} from '@dynobox/sdk';

// Run from the repository: pnpm dynolocal run dynos/linear-mcp.dyno.mts
// Codex: pnpm dynolocal run dynos/linear-mcp.dyno.mts --harness codex --model gpt-5.5 --permission-mode dangerous
// OpenCode: pnpm dynolocal run dynos/linear-mcp.dyno.mts --harness opencode --model openai/gpt-5.5 --permission-mode dangerous --verbose
// All Linear tools below are local fixtures; no Linear account is required.
// This test explicitly uses dangerous permissions for all harness tools.
const issueMocks = (estimateHours: number, loggedHours: number) =>
  ({
    linear: {
      tools: {
        get_issue: {
          description: 'Get a Linear issue by its identifier.',
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}},
            required: ['id'],
          },
          response: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  id: 'DYNO-1',
                  title: 'Linear MCP smoke test',
                  status: 'Todo',
                  estimateHours,
                  loggedHours,
                }),
              },
            ],
          },
        },
        save_issue: {
          description: 'Update a Linear issue.',
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}, state: {type: 'string'}},
            required: ['id'],
          },
          response: {content: [{type: 'text', text: '{"success":true}'}]},
        },
      },
    },
  }) satisfies ScenarioMcpMocks;

const remainingWorkScenario = (
  estimateHours: number,
  loggedHours: number,
  expected: string,
) => ({
  name: `Calculates remaining work from ${estimateHours} estimated and ${loggedHours} logged hours`,
  prompt:
    'Use the Linear MCP get_issue tool to read DYNO-1. Calculate remaining hours by subtracting loggedHours from estimateHours in its response. Do not update the issue. Reply with exactly "DYNO-1: N hours remaining", replacing N with your calculated number.',
  mcpMocks: issueMocks(estimateHours, loggedHours),
  assertions: [
    mcp.called('linear', 'get_issue', {input: {id: 'DYNO-1'}}),
    mcp.notCalled('linear', 'save_issue'),
    finalMessage.contains(expected),
  ],
});

export default defineDyno({
  name: 'Linear MCP smoke test',
  target: 'linear-mcp',
  harnesses: [
    {id: 'claude-code', model: 'sonnet', permissionMode: 'dangerous'},
  ],
  scenarios: [
    remainingWorkScenario(13, 8, 'DYNO-1: 5 hours remaining'),
    remainingWorkScenario(21, 12, 'DYNO-1: 9 hours remaining'),
    {
      name: 'Leaves Linear untouched',
      prompt: 'Do not call any tools. Reply with exactly READY.',
      mcpMocks: issueMocks(13, 8),
      assertions: [
        mcp.notCalled('linear', 'get_issue'),
        mcp.notCalled('linear', 'save_issue'),
        finalMessage.contains('READY'),
      ],
    },
  ],
});
