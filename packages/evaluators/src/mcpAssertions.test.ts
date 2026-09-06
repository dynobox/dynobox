import type {JsonValue} from '@dynobox/sdk';
import type {IrAssertion, McpObservation} from '@dynobox/sdk/ir';
import {describe, expect, it} from 'vitest';

import {
  evaluateAssertions,
  preEvaluateAnyOfObservationBranches,
} from './index.js';
import {evaluateMcpAssertion, matchesMcpInput} from './mcpAssertions.js';

const observation: McpObservation = {
  finalized: true,
  ready: true,
  failures: [],
  tools: {linear: ['save']},
  calls: [
    {
      sequence: 1,
      server: 'linear',
      tool: 'save',
      input: {id: 'SECRET_INPUT', state: 'Done'},
      category: 'tool_error',
    },
  ],
};
const called = {
  id: 'a',
  type: 'mcp.called' as const,
  server: 'linear',
  tool: 'save',
};
const notCalled = {...called, type: 'mcp.notCalled' as const};

describe('MCP input matching', () => {
  it.each<[JsonValue, JsonValue, boolean]>([
    [{a: {b: 1, c: 2}}, {a: {b: 1}}, true],
    [{a: 1}, {missing: null}, false],
    [{a: null}, {a: null}, true],
    [{a: 1}, {a: '1'}, false],
    [[{a: 1, b: 2}], [{a: 1}], true],
    [[1, 2], [1], false],
    [[1, 2], [2, 1], false],
    [[], {}, false],
    [{}, {constructor: {}}, false],
    [false, false, true],
    [0, false, false],
  ])('matches %j against %j: %j', (actual, expected, result) => {
    expect(matchesMcpInput(actual, expected)).toBe(result);
  });
});

describe('MCP assertion evidence', () => {
  it('counts intentional errors and matches inputs without serializing them', () => {
    const result = evaluateMcpAssertion(
      {...called, input: {id: 'SECRET_INPUT'}},
      observation,
    );
    expect(result.passed).toBe(true);
    expect(result.evidence).toMatchObject({
      hasInput: true,
      callCount: 1,
      matchCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_INPUT');
  });

  it('uses exact logical identities and applies the same matcher to absence', () => {
    expect(
      evaluateMcpAssertion(
        {...notCalled, input: {state: 'Canceled'}},
        observation,
      ).passed,
    ).toBe(true);
    expect(evaluateMcpAssertion(notCalled, observation).passed).toBe(false);
    expect(
      evaluateMcpAssertion({...called, server: 'Linear'}, observation).passed,
    ).toBe(false);
  });

  it.each([
    undefined,
    {...observation, finalized: false},
    {...observation, ready: false},
    {...observation, failures: ['cleanup_failed' as const]},
    {...observation, tools: {}},
  ])(
    'rejects incomplete or failed observations %# even with no matching calls',
    (value) => {
      expect(
        evaluateMcpAssertion({...notCalled, input: {state: 'Canceled'}}, value)
          .passed,
      ).toBe(false);
    },
  );

  it('does not fall back to harness MCP events', () => {
    const results = evaluateAssertions({
      assertions: [called, notCalled],
      toolEvents: [{kind: 'mcp', rawName: 'linear.save', input: {}}],
    });
    expect(results.every((result) => !result.passed)).toBe(true);
  });

  it('reuses MCP observation branches when verification is evaluated later', () => {
    const assertion: IrAssertion = {
      id: 'either',
      type: 'anyOf',
      steps: [
        {
          type: 'mcp.called',
          server: 'linear',
          tool: 'save',
          input: {id: 'SECRET_INPUT'},
        },
        {type: 'verify.command', command: 'false', exitCode: 0},
      ],
    };
    const cache = preEvaluateAnyOfObservationBranches([assertion], {
      toolEvents: [],
      mcpObservation: observation,
    });
    const results = evaluateAssertions({
      assertions: [assertion],
      toolEvents: [],
      anyOfObservationBranches: cache,
    });
    expect(results[0]!.passed).toBe(true);
    expect(JSON.stringify(results)).not.toContain('SECRET_INPUT');
  });
});
