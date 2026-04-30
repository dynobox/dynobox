import type {EndpointSpec} from './endpoint-spec.js';

/**
 * Internal brand symbols. Endpoint and assertion objects can only be
 * produced by the SDK helpers — users cannot hand-author them. This keeps
 * the IR a compile target rather than a hand-written format and lets us
 * change internal shapes without breaking authors.
 */
const ENDPOINT_BRAND = Symbol.for('@dynobox/sdk/endpoint');
const ASSERTION_BRAND = Symbol.for('@dynobox/sdk/assertion');

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

export type ShellToolMatcher = {
  [K in ShellToolMatcherKey]: SingleShellToolMatcher<K>;
}[ShellToolMatcherKey];

const shellToolMatcherKeys = new Set<string>(SHELL_TOOL_MATCHER_KEYS);

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

export type Endpoint = EndpointSpec & {
  readonly [ENDPOINT_BRAND]: true;
};

export type CalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.called';
  readonly endpoint: K;
  readonly status?: number;
};

export type NotCalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.notCalled';
  readonly endpoint: K;
};

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

export type Assertion<K extends string = string> =
  | CalledAssertion<K>
  | NotCalledAssertion<K>
  | ToolCalledAssertion;

/**
 * Constructs a branded endpoint. Internal — call via `http.endpoint`.
 *
 * @param spec The author-supplied endpoint shape.
 * @returns A branded endpoint object.
 */
export function brandEndpoint(spec: EndpointSpec): Endpoint {
  return {...spec, [ENDPOINT_BRAND]: true} as Endpoint;
}

/**
 * Constructs a branded `http.called` assertion. Internal — call via
 * `http.called`.
 *
 * @param endpoint The endpoint key being asserted on.
 * @param opts Optional assertion modifiers (e.g. `status`).
 * @returns A branded `http.called` assertion.
 */
export function brandCalled<K extends string>(
  endpoint: K,
  opts?: {status?: number},
): CalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    kind: 'http.called' as const,
    endpoint,
  };
  return opts?.status === undefined
    ? (base as CalledAssertion<K>)
    : ({...base, status: opts.status} as CalledAssertion<K>);
}

/**
 * Constructs a branded `http.notCalled` assertion. Internal — call via
 * `http.notCalled`.
 *
 * @param endpoint The endpoint key being asserted on.
 * @returns A branded `http.notCalled` assertion.
 */
export function brandNotCalled<K extends string>(
  endpoint: K,
): NotCalledAssertion<K> {
  return {
    [ASSERTION_BRAND]: true as const,
    kind: 'http.notCalled' as const,
    endpoint,
  };
}

export function brandToolCalled<K extends ToolKind>(
  toolKind: K,
  matcher?: ShellToolMatcher,
): ToolCalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    kind: 'tool.called' as const,
    toolKind,
  };
  return (matcher === undefined
    ? base
    : {...base, matcher}) as unknown as ToolCalledAssertion<K>;
}
