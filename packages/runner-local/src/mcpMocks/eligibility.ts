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

/** Reject MCP assertions without mocks before creating a workspace. */
export function assertMcpExecutionSupported(
  scenario: LocalRunnerJob['scenario'],
): void {
  if (scenarioUsesMcp(scenario) && scenario.mcpMocks === undefined)
    throw new DynoboxConfigError(
      'MCP assertions require mcpMocks on the scenario.',
    );
}
