import {describe, expect, it} from 'vitest';

import {assertionSchema, scenarioSchema} from './configSchema.js';
import {TOOL_MATCHER_MESSAGES} from './toolMatcherValidation.js';

describe('assertionSchema tool matcher validation', () => {
  it('rejects shell command matchers on non-shell tool assertions', () => {
    const result = assertionSchema.safeParse({
      type: 'tool.called',
      tool: 'edit_file',
      command: {includes: 'src/index.ts'},
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
    const result = assertionSchema.safeParse({
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
      assertionSchema.safeParse({
        type: 'tool.called',
        tool: 'shell',
        command: {includes: 'pnpm test'},
      }).success,
    ).toBe(true);
    expect(
      assertionSchema.safeParse({
        type: 'tool.called',
        tool: 'read_file',
        path: 'package.json',
      }).success,
    ).toBe(true);
  });
});

describe('scenarioSchema cliMocks validation', () => {
  const scenario = {
    name: 'CLI mocks',
    prompt: 'Run the mocked command.',
  };

  it('normalizes static and sequential responses', () => {
    const result = scenarioSchema.parse({
      ...scenario,
      cliMocks: {
        vitest: {response: {exitCode: 0, stdout: 'passed'}},
        vercel: {
          responses: [{exitCode: 1, stderr: 'not ready'}, {exitCode: 0}],
        },
        deploy: {
          responses: [{exitCode: 1}],
          onExhausted: {exitCode: 0, stdout: 'already deployed'},
        },
      },
    });

    expect(result.cliMocks).toEqual({
      vitest: {
        response: {exitCode: 0, stdout: 'passed', stderr: ''},
      },
      vercel: {
        responses: [
          {exitCode: 1, stdout: '', stderr: 'not ready'},
          {exitCode: 0, stdout: '', stderr: ''},
        ],
        onExhausted: 'error',
      },
      deploy: {
        responses: [{exitCode: 1, stdout: '', stderr: ''}],
        onExhausted: {
          exitCode: 0,
          stdout: 'already deployed',
          stderr: '',
        },
      },
    });
  });

  it('accepts repeat-last and preserves handler identity', () => {
    const handler = async () => ({exitCode: 0});
    const result = scenarioSchema.parse({
      ...scenario,
      cliMocks: {
        vitest: {
          responses: [{exitCode: 0}],
          onExhausted: 'repeat-last',
        },
        vercel: {handler},
      },
    });

    expect(result.cliMocks?.vercel).toEqual({handler});
    expect(result.cliMocks?.vitest).toMatchObject({
      onExhausted: 'repeat-last',
    });
  });

  it.each([
    ['', {response: {exitCode: 0}}],
    ['.', {response: {exitCode: 0}}],
    ['..', {response: {exitCode: 0}}],
    ['path/vitest', {response: {exitCode: 0}}],
    ['path\\vitest', {response: {exitCode: 0}}],
    ['vitest\0real', {response: {exitCode: 0}}],
  ])('rejects invalid executable name %j', (executable, config) => {
    expect(
      scenarioSchema.safeParse({
        ...scenario,
        cliMocks: {[executable]: config},
      }).success,
    ).toBe(false);
  });

  it.each([
    {},
    {responses: []},
    {response: {stdout: 'missing exit code'}},
    {response: {exitCode: 0}, responses: [{exitCode: 1}]},
    {response: {exitCode: 0}, handler: () => ({exitCode: 0})},
    {responses: [{exitCode: 0}], handler: () => ({exitCode: 0})},
    {handler: 'not a function'},
  ])('rejects invalid mock config %#', (config) => {
    expect(
      scenarioSchema.safeParse({
        ...scenario,
        cliMocks: {vitest: config},
      }).success,
    ).toBe(false);
  });
});
