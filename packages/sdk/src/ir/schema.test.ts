import {describe, expect, it} from 'vitest';

import {TOOL_MATCHER_MESSAGES} from '../schema/toolMatcherValidation.js';
import {irAssertionSchema} from './schema.js';

describe('irAssertionSchema tool matcher validation', () => {
  it('rejects shell command matchers on non-shell tool assertions', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      kind: 'tool.called',
      toolKind: 'read_file',
      matcher: {includes: 'package.json'},
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['matcher'],
        message: TOOL_MATCHER_MESSAGES.shellMatcherOnlyOnShell,
      }),
    );
  });

  it('rejects path matchers on non-file tool assertions', () => {
    const result = irAssertionSchema.safeParse({
      id: 'assertion.test.0',
      kind: 'tool.called',
      toolKind: 'web_search',
      pathMatcher: {path: 'README.md'},
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected validation to fail');

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['pathMatcher'],
        message: TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
      }),
    );
  });

  it('accepts shell command matchers and file path matchers', () => {
    expect(
      irAssertionSchema.safeParse({
        id: 'assertion.test.0',
        kind: 'tool.called',
        toolKind: 'shell',
        matcher: {includes: 'pnpm test'},
      }).success,
    ).toBe(true);
    expect(
      irAssertionSchema.safeParse({
        id: 'assertion.test.1',
        kind: 'tool.called',
        toolKind: 'read_file',
        pathMatcher: {path: 'package.json'},
      }).success,
    ).toBe(true);
  });
});
