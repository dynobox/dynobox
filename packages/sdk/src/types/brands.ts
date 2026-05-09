import type {EndpointSpec} from './endpoint-spec.js';

/**
 * Brand symbols backing opaque authoring types. Endpoint and assertion objects
 * are produced by SDK helpers so the IR stays a compile target rather than a
 * hand-written format.
 */
export const ENDPOINT_BRAND = Symbol.for('@dynobox/sdk/endpoint');
export const ASSERTION_BRAND = Symbol.for('@dynobox/sdk/assertion');

/** Canonical tool kinds used by authoring helpers, IR, and harness adapters. */
export const TOOL_KINDS = [
  'shell',
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'web_fetch',
  'web_search',
  'mcp',
  'task',
  'unknown',
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

const SHELL_TOOL_MATCHER_KEYS = [
  'equals',
  'includes',
  'startsWith',
  'matches',
] as const;

type ShellToolMatcherKey = (typeof SHELL_TOOL_MATCHER_KEYS)[number];

type SingleShellToolMatcher<K extends ShellToolMatcherKey> = {
  readonly [P in K]: string;
} & {
  readonly [P in Exclude<ShellToolMatcherKey, K>]?: never;
};

/**
 * Shell command matcher. Exactly one strategy is allowed so assertions are
 * unambiguous and renderer/evaluator messages can describe intent clearly.
 */
export type ShellToolMatcher = {
  [K in ShellToolMatcherKey]: SingleShellToolMatcher<K>;
}[ShellToolMatcherKey];

const shellToolMatcherKeys = new Set<string>(SHELL_TOOL_MATCHER_KEYS);

/** Runtime guard used by Zod schemas and evaluator code for shell matchers. */
export function isShellToolMatcher(value: unknown): value is ShellToolMatcher {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) {
    return false;
  }

  const [key, matcherValue] = entries[0]!;
  return shellToolMatcherKeys.has(key) && typeof matcherValue === 'string';
}

/** Endpoint definition produced by `http.endpoint`. */
export type Endpoint = EndpointSpec & {
  readonly [ENDPOINT_BRAND]: true;
};

/** Assertion that a named HTTP endpoint should be observed. */
export type CalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.called';
  readonly endpoint: K;
  readonly status?: number;
};

/** Assertion that a named HTTP endpoint should not be observed. */
export type NotCalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.notCalled';
  readonly endpoint: K;
};

/** Assertion that a harness should call a tool, optionally matching shell text. */
export type ToolCalledAssertion<K extends ToolKind = ToolKind> =
  K extends 'shell'
    ? {
        readonly [ASSERTION_BRAND]: true;
        readonly kind: 'tool.called';
        readonly toolKind: 'shell';
        readonly matcher?: ShellToolMatcher;
      }
    : {
        readonly [ASSERTION_BRAND]: true;
        readonly kind: 'tool.called';
        readonly toolKind: K;
      };

/** Assertion that a harness should not call a tool. */
export type ToolNotCalledAssertion<K extends ToolKind = ToolKind> =
  K extends 'shell'
    ? {
        readonly [ASSERTION_BRAND]: true;
        readonly kind: 'tool.notCalled';
        readonly toolKind: 'shell';
        readonly matcher?: ShellToolMatcher;
      }
    : {
        readonly [ASSERTION_BRAND]: true;
        readonly kind: 'tool.notCalled';
        readonly toolKind: K;
      };

/** Assertion that a work-directory artifact exists. */
export type ArtifactExistsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'artifact.exists';
  readonly path: string;
};

/** Assertion that a work-directory artifact contains text. */
export type ArtifactContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'artifact.contains';
  readonly path: string;
  readonly text: string;
};

/** Assertion that the full harness transcript contains text. */
export type TranscriptContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'transcript.contains';
  readonly text: string;
};

/** Assertion that the extracted final assistant message contains text. */
export type FinalMessageContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'finalMessage.contains';
  readonly text: string;
};

/** Assertion that positive tool calls occur in order. */
export type SequenceInOrderAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'sequence.inOrder';
  readonly steps: readonly ToolCalledAssertion[];
};

/** Union of all author-facing assertion objects accepted by config scenarios. */
export type Assertion<K extends string = string> =
  | CalledAssertion<K>
  | NotCalledAssertion<K>
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ArtifactExistsAssertion
  | ArtifactContainsAssertion
  | TranscriptContainsAssertion
  | FinalMessageContainsAssertion
  | SequenceInOrderAssertion;
