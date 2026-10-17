import type {JsonValue} from '@dynobox/sdk';
import type {IrAssertion, McpObservation} from '@dynobox/sdk/ir';

import type {AssertionResult} from './types.js';

type McpAssertion = Extract<
  IrAssertion,
  {type: 'mcp.called' | 'mcp.notCalled'}
>;

/** Objects are deep-partial; arrays require the same length and order. */
export function matchesMcpInput(
  actual: JsonValue,
  expected: JsonValue,
): boolean {
  if (expected === null || typeof expected !== 'object')
    return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesMcpInput(actual[index]!, value))
    );
  }
  if (Array.isArray(actual)) return false;
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) && matchesMcpInput(actual[key]!, value),
  );
}

/** Results contain logical identities and counts only, never raw arguments. */
export function evaluateMcpAssertion(
  assertion: McpAssertion,
  observation?: McpObservation,
): AssertionResult {
  const available =
    observation !== undefined &&
    observation.finalized &&
    observation.ready &&
    observation.failures.length === 0 &&
    Object.hasOwn(observation.tools, assertion.server) &&
    observation.tools[assertion.server]!.includes(assertion.tool);
  const calls =
    observation?.calls.filter(
      (call) =>
        call.server === assertion.server && call.tool === assertion.tool,
    ) ?? [];
  const matchCount = calls.filter(
    (call) =>
      assertion.input === undefined ||
      matchesMcpInput(call.input, assertion.input),
  ).length;
  const passed =
    available &&
    (assertion.type === 'mcp.called' ? matchCount > 0 : matchCount === 0);
  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed,
    message: !available
      ? 'MCP mock observation is not ready, successfully finalized, or declared for this tool.'
      : `${assertion.server}.${assertion.tool}: ${matchCount} matching call(s); expected ${assertion.type === 'mcp.called' ? 'at least one' : 'none'}.`,
    evidence: {
      kind: 'mcp',
      server: assertion.server,
      tool: assertion.tool,
      hasInput: assertion.input !== undefined,
      callCount: calls.length,
      matchCount,
      ...(!available ? {failure: 'observation_unavailable'} : {}),
    },
  };
}
