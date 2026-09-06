import type {IrAssertion} from '@dynobox/sdk/ir';
import {expect, it} from 'vitest';

import {describeAssertion, describeExpectation} from './describe.js';

it('describes MCP identities and matcher presence without exposing input values', () => {
  const assertion: IrAssertion = {
    id: 'a',
    type: 'mcp.notCalled',
    server: 'linear',
    tool: 'save',
    input: {id: 'SECRET_INPUT'},
  };
  expect(describeAssertion(assertion)).toBe(
    'mcp.notCalled(linear, save, with input matcher)',
  );
  expect(describeExpectation(assertion)).toBe(
    'no linear.save mock call matching the expected input',
  );
  const {id: _id, ...branch} = assertion;
  expect(
    describeExpectation({id: 'b', type: 'anyOf', steps: [branch]}),
  ).not.toContain('SECRET_INPUT');
});
