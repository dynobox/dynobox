import type {EndpointSpec} from './endpointSpec.js';

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
export type FileToolKind = Extract<
  ToolKind,
  'read_file' | 'write_file' | 'edit_file' | 'search_files'
>;

const SHELL_COMMAND_MATCHER_KEYS = [
  'equals',
  'includes',
  'startsWith',
  'matches',
] as const;

type ShellCommandMatcherKey = (typeof SHELL_COMMAND_MATCHER_KEYS)[number];

type SingleShellCommandMatcher<K extends ShellCommandMatcherKey> = {
  readonly [P in K]: string;
} & {
  readonly [P in Exclude<ShellCommandMatcherKey, K>]?: never;
};

/**
 * Shell command matcher. Exactly one strategy is allowed so assertions are
 * unambiguous and renderer/evaluator messages can describe intent clearly.
 */
export type ShellCommandMatcher = {
  [K in ShellCommandMatcherKey]: SingleShellCommandMatcher<K>;
}[ShellCommandMatcherKey];

/** @deprecated Use `ShellCommandMatcher`. */
export type ShellToolMatcher = ShellCommandMatcher;

/** Matcher for tools that operate on filesystem paths. */
export type ToolPathMatcher = {
  readonly path: string;
};

/** Matcher for normalized observed shell command segments. */
export type CommandMatcher = {
  readonly args?: readonly string[];
  readonly argsInOrder?: readonly string[];
  readonly argsMatching?: readonly RegExp[];
  readonly originalIncludes?: string;
  readonly originalMatches?: RegExp;
};

/** Matcher for text captured from post-harness verification commands. */
export type TextMatcher = ShellCommandMatcher;

/** Options for a post-harness verification command assertion. */
export type VerifyCommandOptions = {
  readonly exitCode?: number;
  readonly stdout?: TextMatcher;
  readonly stderr?: TextMatcher;
};

const shellCommandMatcherKeys = new Set<string>(SHELL_COMMAND_MATCHER_KEYS);

/** Runtime guard used by Zod schemas and evaluator code for shell matchers. */
export function isShellCommandMatcher(
  value: unknown,
): value is ShellCommandMatcher {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) {
    return false;
  }

  const [key, matcherValue] = entries[0]!;
  return shellCommandMatcherKeys.has(key) && typeof matcherValue === 'string';
}

/** @deprecated Use `isShellCommandMatcher`. */
export const isShellToolMatcher = isShellCommandMatcher;

/** Endpoint definition produced by `http.endpoint`. */
export type Endpoint = EndpointSpec & {
  readonly [ENDPOINT_BRAND]: true;
};

/** Assertion that a named HTTP endpoint should be observed. */
export type CalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'http.called';
  readonly endpoint: K;
  readonly status?: number;
};

/** Assertion that a named HTTP endpoint should not be observed. */
export type NotCalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'http.notCalled';
  readonly endpoint: K;
};

/** Assertion that a harness should call a tool, optionally matching shell text. */
export type ToolCalledAssertion<K extends ToolKind = ToolKind> =
  K extends 'shell'
    ? {
        readonly [ASSERTION_BRAND]: true;
        readonly id?: string;
        readonly label?: string;
        readonly type: 'tool.called';
        readonly tool: 'shell';
        readonly command?: ShellCommandMatcher;
      }
    : K extends FileToolKind
      ? {
          readonly [ASSERTION_BRAND]: true;
          readonly id?: string;
          readonly label?: string;
          readonly type: 'tool.called';
          readonly tool: K;
          readonly path?: string;
        }
      : {
          readonly [ASSERTION_BRAND]: true;
          readonly id?: string;
          readonly label?: string;
          readonly type: 'tool.called';
          readonly tool: K;
        };

/** Assertion that a harness should not call a tool. */
export type ToolNotCalledAssertion<K extends ToolKind = ToolKind> =
  K extends 'shell'
    ? {
        readonly [ASSERTION_BRAND]: true;
        readonly id?: string;
        readonly label?: string;
        readonly type: 'tool.notCalled';
        readonly tool: 'shell';
        readonly command?: ShellCommandMatcher;
      }
    : K extends FileToolKind
      ? {
          readonly [ASSERTION_BRAND]: true;
          readonly id?: string;
          readonly label?: string;
          readonly type: 'tool.notCalled';
          readonly tool: K;
          readonly path?: string;
        }
      : {
          readonly [ASSERTION_BRAND]: true;
          readonly id?: string;
          readonly label?: string;
          readonly type: 'tool.notCalled';
          readonly tool: K;
        };

/** Assertion that a normalized command segment should be observed. */
export type CommandCalledAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'command.called';
  readonly executable: string;
  readonly command?: CommandMatcher;
};

/** Assertion that a normalized command segment should not be observed. */
export type CommandNotCalledAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'command.notCalled';
  readonly executable: string;
  readonly command?: CommandMatcher;
};

/** Assertion that a post-harness verification command should satisfy checks. */
export type VerifyCommandAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'verify.command';
  readonly command: string;
  readonly exitCode?: number;
  readonly stdout?: TextMatcher;
  readonly stderr?: TextMatcher;
};

/** Assertion that a work-directory artifact exists. */
export type ArtifactExistsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'artifact.exists';
  readonly path: string;
};

/** Assertion that a work-directory artifact contains text. */
export type ArtifactContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'artifact.contains';
  readonly path: string;
  readonly text: string;
};

/** Assertion that the full harness transcript contains text. */
export type TranscriptContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'transcript.contains';
  readonly text: string;
};

/** Assertion that the extracted final assistant message contains text. */
export type FinalMessageContainsAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'finalMessage.contains';
  readonly text: string;
};

/** Assertion that positive tool calls occur in order. */
export type SequenceInOrderAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'sequence.inOrder';
  readonly steps: readonly (ToolCalledAssertion | CommandCalledAssertion)[];
};

/** Assertion that observed harness events referenced a named skill instruction file. */
export type SkillReferencedAssertion = {
  readonly [ASSERTION_BRAND]: true;
  readonly id?: string;
  readonly label?: string;
  readonly type: 'skill.referenced';
  readonly skill: string;
};

/** Union of all author-facing assertion objects accepted by config scenarios. */
export type Assertion<K extends string = string> =
  | CalledAssertion<K>
  | NotCalledAssertion<K>
  | CommandCalledAssertion
  | CommandNotCalledAssertion
  | VerifyCommandAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ArtifactExistsAssertion
  | ArtifactContainsAssertion
  | TranscriptContainsAssertion
  | FinalMessageContainsAssertion
  | SequenceInOrderAssertion
  | SkillReferencedAssertion;
