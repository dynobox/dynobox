import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  addToolMatcherIssues,
  FILE_TOOL_KINDS,
  isToolAssertionKind,
  TOOL_MATCHER_MESSAGES,
  validateToolAssertionNode,
} from './toolMatcherValidation.js';

function collectIssues(fn: (ctx: z.RefinementCtx) => void): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  const ctx = {
    addIssue: (issue: z.ZodIssue) => {
      issues.push(issue);
    },
  } as z.RefinementCtx;
  fn(ctx);
  return issues;
}

describe('toolMatcherValidation', () => {
  it('exports the file-oriented tool kinds once', () => {
    expect([...FILE_TOOL_KINDS]).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'search_files',
    ]);
  });

  it('recognizes tool assertion kinds', () => {
    expect(isToolAssertionKind('tool.called')).toBe(true);
    expect(isToolAssertionKind('tool.notCalled')).toBe(true);
    expect(isToolAssertionKind('http.called')).toBe(false);
  });

  it('rejects shell command matchers on non-shell tool assertions', () => {
    const issues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        ['assertions', 0],
        {
          toolKind: 'edit_file',
          shellMatcher: {includes: 'src/index.ts'},
        },
        {shellMatcherField: 'command', pathMatcherField: 'path'},
        TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ['assertions', 0, 'command'],
      message: TOOL_MATCHER_MESSAGES.shellMatcherOnlyOnShell,
    });
  });

  it('rejects path matchers on non-file tool assertions', () => {
    const issues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        [],
        {
          toolKind: 'web_search',
          pathMatcher: {path: 'README.md'},
        },
        {shellMatcherField: 'matcher', pathMatcherField: 'pathMatcher'},
        TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ['pathMatcher'],
      message: TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
    });
  });

  it('rejects specifying both a shell command matcher and a path matcher', () => {
    const issues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        ['steps', 1],
        {
          toolKind: 'shell',
          shellMatcher: {includes: 'pnpm test'},
          pathMatcher: {path: 'README.md'},
        },
        {shellMatcherField: 'command', pathMatcherField: 'path'},
        TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.message)).toEqual([
      TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
      TOOL_MATCHER_MESSAGES.notBoth,
    ]);
    expect(issues[1]).toMatchObject({
      path: ['steps', 1, 'path'],
    });
  });

  it('accepts valid shell command matcher and file path matcher combinations', () => {
    const shellIssues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        [],
        {
          toolKind: 'shell',
          shellMatcher: {includes: 'pnpm test'},
        },
        {shellMatcherField: 'command', pathMatcherField: 'path'},
        TOOL_MATCHER_MESSAGES,
      );
    });
    const fileIssues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        [],
        {
          toolKind: 'read_file',
          pathMatcher: {path: 'package.json'},
        },
        {shellMatcherField: 'matcher', pathMatcherField: 'pathMatcher'},
        TOOL_MATCHER_MESSAGES,
      );
    });

    expect(shellIssues).toHaveLength(0);
    expect(fileIssues).toHaveLength(0);
  });

  it('validates nested authoring tool assertion nodes', () => {
    const issues = collectIssues((ctx) => {
      validateToolAssertionNode(
        {
          type: 'tool.called',
          tool: 'edit_file',
          command: {includes: 'src/index.ts'},
        },
        ctx,
        ['steps', 0],
        {
          kindField: 'type',
          toolKindField: 'tool',
          shellMatcherField: 'command',
          pathMatcherField: 'path',
          messages: TOOL_MATCHER_MESSAGES,
        },
      );
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['steps', 0, 'command']);
  });

  it('ignores non-tool assertion nodes', () => {
    const issues = collectIssues((ctx) => {
      validateToolAssertionNode(
        {kind: 'artifact.exists', path: 'README.md'},
        ctx,
        [],
        {
          kindField: 'kind',
          toolKindField: 'toolKind',
          shellMatcherField: 'matcher',
          pathMatcherField: 'pathMatcher',
          messages: TOOL_MATCHER_MESSAGES,
        },
      );
    });

    expect(issues).toHaveLength(0);
  });
});
