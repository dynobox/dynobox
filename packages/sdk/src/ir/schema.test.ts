import {describe, expect, it} from 'vitest';

import {TOOL_MATCHER_MESSAGES} from '../schema/toolMatcherValidation.js';
import {irAssertionSchema, irScenarioSchema} from './schema.js';

describe('irAssertionSchema tool matcher validation', () => {
  it('rejects shell command matchers on non-shell tool assertions', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'tool.called',
      tool: 'read_file',
      command: {includes: 'package.json'},
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['command'],
        message: TOOL_MATCHER_MESSAGES.shellMatcherOnlyOnShell,
      }),
    );
  });

  it('rejects path matchers on non-file tool assertions', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'tool.called',
      tool: 'web_search',
      path: 'README.md',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['path'],
        message: TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
      }),
    );
  });

  it('accepts shell command matchers and file path matchers', () => {
    expect(
      irAssertionSchema.safeParse({
        id: 'assertion.test.0',
        type: 'tool.called',
        tool: 'shell',
        command: {includes: 'pnpm test'},
      }).success,
    ).toBe(true);
    expect(
      irAssertionSchema.safeParse({
        id: 'assertion.test.1',
        type: 'tool.called',
        tool: 'read_file',
        path: 'package.json',
      }).success,
    ).toBe(true);
  });

  it('reports sequence step matcher errors at the nested step path', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'sequence.inOrder',
      steps: [
        {
          type: 'tool.called',
          tool: 'read_file',
          command: {includes: 'package.json'},
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['steps', 0, 'command'],
        message: TOOL_MATCHER_MESSAGES.shellMatcherOnlyOnShell,
      }),
    );
  });

  it('reports anyOf branch matcher errors once at the branch path', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'anyOf',
      steps: [
        {
          type: 'tool.called',
          tool: 'read_file',
          command: {includes: 'package.json'},
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(
      result.error.issues.filter(
        (issue) => issue.path.join('.') === 'steps.0.command',
      ),
    ).toHaveLength(1);
  });

  it('accepts verify command assertions inside anyOf branches', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'anyOf',
      steps: [
        {
          type: 'verify.command',
          command: 'pnpm test',
          exitCode: 0,
        },
        {
          type: 'artifact.notExists',
          path: 'scratch.tmp',
        },
        {
          type: 'artifact.unchanged',
          path: 'package.json',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('rejects incomplete verify command assertions inside anyOf branches', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'anyOf',
      steps: [
        {
          type: 'verify.command',
          command: 'pnpm test',
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        message:
          'Verify command assertions must specify exitCode, stdout, or stderr.',
      }),
    );
  });
});

describe('irScenarioSchema cliMocks validation', () => {
  const scenario = {
    id: 'scenario.cli-mocks',
    name: 'CLI mocks',
    prompt: 'Run the mocked command.',
    harnesses: [{id: 'claude-code' as const}],
    setup: [],
    fixtures: [],
    endpoints: [],
    assertions: [],
  };

  it('accepts normalized response strategies and handlers', () => {
    const handler = () => ({exitCode: 0});
    const result = irScenarioSchema.parse({
      ...scenario,
      cliMocks: {
        vitest: {
          response: {exitCode: 0, stdout: 'passed', stderr: ''},
        },
        vercel: {
          responses: [{exitCode: 1, stdout: '', stderr: 'not ready'}],
          onExhausted: {exitCode: 0, stdout: 'deployed', stderr: ''},
        },
        custom: {handler},
      },
    });

    expect(result.cliMocks.custom).toEqual({handler});
  });

  it.each([
    {response: {exitCode: 0, stdout: 'missing stderr'}},
    {
      responses: [{exitCode: 0, stdout: '', stderr: ''}],
    },
    {
      responses: [],
      onExhausted: 'error',
    },
    {
      response: {exitCode: 0, stdout: '', stderr: ''},
      handler: () => ({exitCode: 0}),
    },
  ])('rejects non-canonical mock config %#', (config) => {
    expect(
      irScenarioSchema.safeParse({
        ...scenario,
        cliMocks: {vitest: config},
      }).success,
    ).toBe(false);
  });

  it('requires the canonical CLI mock map', () => {
    expect(irScenarioSchema.safeParse(scenario).success).toBe(false);
  });
});
