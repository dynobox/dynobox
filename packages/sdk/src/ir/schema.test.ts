import {describe, expect, it} from 'vitest';

import {TOOL_MATCHER_MESSAGES} from '../schema/toolMatcherValidation.js';
import {irAssertionSchema} from './schema.js';

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

  it('rejects verify command assertions inside anyOf branches', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      type: 'anyOf',
      steps: [
        {
          type: 'verify.command',
          command: 'pnpm test',
          exitCode: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(
      result.error.issues.some(
        (issue) => issue.path[0] === 'steps' && issue.path[1] === 0,
      ),
    ).toBe(true);
  });
});
