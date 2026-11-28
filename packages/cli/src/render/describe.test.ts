import type {IrAssertion} from '@dynobox/sdk/ir';
import {expect, it} from 'vitest';

import {
  describeAssertion,
  describeExpectation,
  describeToolEvent,
} from './describe.js';

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

it('describes a shell tool event that has no command', () => {
  expect(describeToolEvent({kind: 'shell', rawName: 'Bash', input: {}})).toBe(
    'Bash',
  );
});

it('shows the text that contains assertions look for', () => {
  expect(
    describeAssertion({id: 'a', type: 'transcript.contains', text: 'not ok'}),
  ).toBe('transcript.contains("not ok")');
  expect(
    describeAssertion({
      id: 'b',
      type: 'finalMessage.contains',
      text: 'say "hi"\nthen stop',
    }),
  ).toBe('finalMessage.contains("say \\"hi\\"\\nthen stop")');
  expect(
    describeAssertion({
      id: 'c',
      type: 'artifact.contains',
      path: '.env',
      text: 'PAST_API_KEY=',
    }),
  ).toBe('artifact.contains(.env, "PAST_API_KEY=")');
});

it('describes HTTP body matchers and web_fetch url/status matchers', () => {
  expect(
    describeAssertion({
      id: 'h1',
      type: 'http.called',
      endpointId: 'endpoint.recall',
      status: 200,
      json: {identity: 'sam@example.com'},
    }),
  ).toBe(
    'http.called(endpoint.recall, status: 200, json: {"identity":"sam@example.com"})',
  );
  expect(
    describeAssertion({
      id: 'h2',
      type: 'http.notCalled',
      endpointId: 'endpoint.ingest',
      bodyIncludes: 'secret',
    }),
  ).toBe('http.notCalled(endpoint.ingest, bodyIncludes: "secret")');
  expect(
    describeAssertion({
      id: 'w1',
      type: 'tool.called',
      tool: 'web_fetch',
      url: 'https://past.dev/SKILL.md',
    }),
  ).toBe('tool.called(web_fetch, url: https://past.dev/SKILL.md)');
  expect(
    describeExpectation({
      id: 'w1',
      type: 'tool.called',
      tool: 'web_fetch',
      url: 'https://past.dev/SKILL.md',
    }),
  ).toBe('web_fetch tool call for url "https://past.dev/SKILL.md"');
});
