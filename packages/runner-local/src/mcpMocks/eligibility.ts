import {DynoboxConfigError} from '@dynobox/sdk/compiler';

import type {LocalRunnerJob} from '../runTypes.js';

/** True when a scenario declares MCP mocks or asserts on MCP calls. */
export function scenarioUsesMcp(scenario: LocalRunnerJob['scenario']): boolean {
  const isMcp = (type: string) =>
    type === 'mcp.called' || type === 'mcp.notCalled';
  return (
    scenario.mcpMocks !== undefined ||
    scenario.assertions.some(
      (assertion) =>
        isMcp(assertion.type) ||
        (assertion.type === 'anyOf' &&
          assertion.steps.some((step) => isMcp(step.type))),
    )
  );
}

/** Reject unsupported MCP runs before scheduling or creating a workspace. */
export function assertMcpExecutionSupported(
  scenario: LocalRunnerJob['scenario'],
  harness?: LocalRunnerJob['harness'],
): void {
  if (scenarioUsesMcp(scenario)) {
    const harnessIds =
      harness === undefined
        ? scenario.harnesses.map((entry) => entry.id)
        : [harness];
    if (harnessIds.includes('cursor'))
      throw new DynoboxConfigError(
        'MCP mocking is unavailable for Cursor: plugin-provided MCP servers cannot be isolated from this CLI run.',
      );
    if (
      harnessIds.some(
        (id) =>
          id !== 'claude-code' &&
          id !== 'codex' &&
          id !== 'opencode' &&
          id !== 'pi' &&
          id !== 'antigravity',
      )
    ) {
      throw new DynoboxConfigError(
        'MCP mocking is unsupported for this harness. Use claude-code, codex, opencode, pi, or antigravity.',
      );
    }
    if (scenario.mcpMocks === undefined)
      throw new DynoboxConfigError(
        'MCP assertions require mcpMocks on the scenario.',
      );
  }
}
