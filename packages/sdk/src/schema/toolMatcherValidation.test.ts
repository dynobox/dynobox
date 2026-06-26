import {describe, expect, it} from 'vitest';
import {z} from 'zod';

import {
  addToolMatcherIssues,
  AUTHORING_TOOL_MATCHER_MESSAGES,
  FILE_TOOL_KINDS,
  IR_TOOL_MATCHER_MESSAGES,
  isToolAssertionKind,
  validateToolAssertionNode,
} from './toolMatcherValidation.js';

function collectIssues(
  fn: (ctx: z.RefinementCtx) => void,
): z.ZodIssue[] {
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

  it('rejects shell matchers on non-shell tool assertions', () => {
    const issues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        ['assertions', 0],
        {
          toolKind: 'edit_file',
          shellMatcher: {includes: 'src/index.ts'},
        },
        {shellMatcher: 'command', pathMatcher: 'path'},
        AUTHORING_TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ['assertions', 0, 'command'],
      message: AUTHORING_TOOL_MATCHER_MESSAGES.shellMatcherOnlyOnShell,
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
        {shellMatcher: 'matcher', pathMatcher: 'pathMatcher'},
        IR_TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ['pathMatcher'],
      message: IR_TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
    });
  });

  it('rejects specifying both shell and path matchers', () => {
    const issues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        ['steps', 1],
        {
          toolKind: 'shell',
          shellMatcher: {includes: 'pnpm test'},
          pathMatcher: {path: 'README.md'},
        },
        {shellMatcher: 'command', pathMatcher: 'path'},
        AUTHORING_TOOL_MATCHER_MESSAGES,
      );
    });

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.message)).toEqual([
      AUTHORING_TOOL_MATCHER_MESSAGES.pathMatcherOnlyOnFileTools,
      AUTHORING_TOOL_MATCHER_MESSAGES.notBoth,
    ]);
    expect(issues[1]).toMatchObject({
      path: ['steps', 1, 'path'],
    });
  });

  it('accepts valid shell and file tool matcher combinations', () => {
    const shellIssues = collectIssues((ctx) => {
      addToolMatcherIssues(
        ctx,
        [],
        {
          toolKind: 'shell',
          shellMatcher: {includes: 'pnpm test'},
        },
        {shellMatcher: 'command', pathMatcher: 'path'},
        AUTHORING_TOOL_MATCHER_MESSAGES,
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
        {shellMatcher: 'matcher', pathMatcher: 'pathMatcher'},
        IR_TOOL_MATCHER_MESSAGES,
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
          fieldPaths: {shellMatcher: 'command', pathMatcher: 'path'},
          messages: AUTHORING_TOOL_MATCHER_MESSAGES,
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
          fieldPaths: {shellMatcher: 'matcher', pathMatcher: 'pathMatcher'},
          messages: IR_TOOL_MATCHER_MESSAGES,
        },
      );
    });

    expect(issues).toHaveLength(0);
  });
});