import {z} from 'zod';

import type {FileToolKind} from '../types/brands.js';

/** File-oriented tool kinds that may carry a path matcher. */
export const FILE_TOOL_KINDS = new Set<FileToolKind>([
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
]);

export type ToolMatcherValidationMessages = {
  shellMatcherOnlyOnShell: string;
  pathMatcherOnlyOnFileTools: string;
  notBoth: string;
};

/** Zod error when a shell command matcher object has the wrong shape. */
export const SHELL_COMMAND_MATCHER_SHAPE_MESSAGE =
  'Shell command matcher must specify exactly one string field: equals, includes, startsWith, or matches.';

/** Semantic validation errors for tool assertion shell/path matcher placement. */
export const TOOL_MATCHER_MESSAGES: ToolMatcherValidationMessages = {
  shellMatcherOnlyOnShell:
    'Shell command matchers are only supported on shell tool assertions.',
  pathMatcherOnlyOnFileTools:
    'Path matchers are only supported on file-oriented tool assertions.',
  notBoth:
    'Tool assertions may specify a shell command matcher or a path matcher, not both.',
};

const TOOL_ASSERTION_KINDS = ['tool.called', 'tool.notCalled'] as const;

export function isToolAssertionKind(kind: string): boolean {
  return (TOOL_ASSERTION_KINDS as readonly string[]).includes(kind);
}

export function addToolMatcherIssues(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  fields: {
    toolKind: string;
    shellMatcher?: unknown;
    pathMatcher?: unknown;
  },
  fieldNames: {
    shellMatcherField: string;
    pathMatcherField: string;
  },
  messages: ToolMatcherValidationMessages,
): void {
  const {toolKind, shellMatcher, pathMatcher} = fields;
  const {shellMatcherField, pathMatcherField} = fieldNames;

  if (shellMatcher !== undefined && toolKind !== 'shell') {
    ctx.addIssue({
      code: 'custom',
      path: [...path, shellMatcherField],
      message: messages.shellMatcherOnlyOnShell,
    });
  }

  if (
    pathMatcher !== undefined &&
    !FILE_TOOL_KINDS.has(toolKind as FileToolKind)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, pathMatcherField],
      message: messages.pathMatcherOnlyOnFileTools,
    });
  }

  if (shellMatcher !== undefined && pathMatcher !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, pathMatcherField],
      message: messages.notBoth,
    });
  }
}

export function validateToolAssertionNode(
  assertion: unknown,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  options: {
    kindField: 'type' | 'kind';
    toolKindField: string;
    shellMatcherField: string;
    pathMatcherField: string;
    messages: ToolMatcherValidationMessages;
  },
): void {
  if (typeof assertion !== 'object' || assertion === null) {
    return;
  }

  const record = assertion as Record<string, unknown>;
  const kind = record[options.kindField];
  if (typeof kind !== 'string' || !isToolAssertionKind(kind)) {
    return;
  }

  addToolMatcherIssues(
    ctx,
    path,
    {
      toolKind: String(record[options.toolKindField] ?? ''),
      shellMatcher: record[options.shellMatcherField],
      pathMatcher: record[options.pathMatcherField],
    },
    {
      shellMatcherField: options.shellMatcherField,
      pathMatcherField: options.pathMatcherField,
    },
    options.messages,
  );
}
