import {describe, expect, it} from 'vitest';

import {assertionSchema} from './configSchema.js';
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
