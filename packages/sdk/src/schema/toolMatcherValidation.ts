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
  webFetchMatcherOnlyOnWebFetch?: string;
  notBoth: string;
};

/** Zod error when a shell command matcher object has the wrong shape. */
export const SHELL_COMMAND_MATCHER_SHAPE_MESSAGE =
  'Shell command matcher must specify exactly one string field: equals, includes, startsWith, or matches.';

const DEFAULT_WEB_FETCH_MATCHER_MESSAGE =
  'URL and status matchers are only supported on web_fetch tool assertions.';

/** Semantic validation errors for tool assertion shell/path/web_fetch matcher placement. */
export const TOOL_MATCHER_MESSAGES: ToolMatcherValidationMessages = {
  shellMatcherOnlyOnShell:
    'Shell command matchers are only supported on shell tool assertions.',
  pathMatcherOnlyOnFileTools:
    'Path matchers are only supported on file-oriented tool assertions.',
  webFetchMatcherOnlyOnWebFetch: DEFAULT_WEB_FETCH_MATCHER_MESSAGE,
  notBoth:
    'Tool assertions may specify a shell command matcher, a path matcher, or a web_fetch matcher, not more than one.',
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
    urlMatcher?: unknown;
    statusMatcher?: unknown;
  },
  fieldNames: {
    shellMatcherField: string;
    pathMatcherField: string;
    urlMatcherField?: string;
    statusMatcherField?: string;
  },
  messages: ToolMatcherValidationMessages,
): void {
  const {toolKind, shellMatcher, pathMatcher, urlMatcher, statusMatcher} =
    fields;
  const {
    shellMatcherField,
    pathMatcherField,
    urlMatcherField = 'url',
    statusMatcherField = 'status',
  } = fieldNames;
  const webFetchMessage =
    messages.webFetchMatcherOnlyOnWebFetch ?? DEFAULT_WEB_FETCH_MATCHER_MESSAGE;

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

  if (urlMatcher !== undefined && toolKind !== 'web_fetch') {
    ctx.addIssue({
      code: 'custom',
      path: [...path, urlMatcherField],
      message: webFetchMessage,
    });
  }

  if (statusMatcher !== undefined && toolKind !== 'web_fetch') {
    ctx.addIssue({
      code: 'custom',
      path: [...path, statusMatcherField],
      message: webFetchMessage,
    });
  }

  const hasWebFetchMatcher =
    urlMatcher !== undefined || statusMatcher !== undefined;
  const matcherFamilies = [
    shellMatcher !== undefined,
    pathMatcher !== undefined,
    hasWebFetchMatcher,
  ].filter(Boolean).length;

  if (matcherFamilies > 1) {
    const conflictField =
      pathMatcher !== undefined
        ? pathMatcherField
        : urlMatcher !== undefined
          ? urlMatcherField
          : statusMatcherField;
    ctx.addIssue({
      code: 'custom',
      path: [...path, conflictField],
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
    urlMatcherField?: string;
    statusMatcherField?: string;
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

  const urlMatcherField = options.urlMatcherField ?? 'url';
  const statusMatcherField = options.statusMatcherField ?? 'status';

  addToolMatcherIssues(
    ctx,
    path,
    {
      toolKind: String(record[options.toolKindField] ?? ''),
      shellMatcher: record[options.shellMatcherField],
      pathMatcher: record[options.pathMatcherField],
      urlMatcher: record[urlMatcherField],
      statusMatcher: record[statusMatcherField],
    },
    {
      shellMatcherField: options.shellMatcherField,
      pathMatcherField: options.pathMatcherField,
      urlMatcherField,
      statusMatcherField,
    },
    options.messages,
  );
}
