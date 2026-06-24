import type {
  AnyOfAssertion,
  AnyOfBranchAssertion,
  ArtifactContainsAssertion,
  ArtifactExistsAssertion,
  CalledAssertion,
  CommandCalledAssertion,
  CommandMatcher,
  CommandNotCalledAssertion,
  Endpoint,
  FinalMessageContainsAssertion,
  NotCalledAssertion,
  SequenceInOrderAssertion,
  SequenceStepAssertion,
  ShellCommandMatcher,
  SkillReferencedAssertion,
  ToolCalledAssertion,
  ToolKind,
  ToolNotCalledAssertion,
  ToolPathMatcher,
  TranscriptContainsAssertion,
  VerifyCommandAssertion,
  VerifyCommandOptions,
} from '../types/brands.js';
import {ASSERTION_BRAND, ENDPOINT_BRAND} from '../types/brands.js';
import type {EndpointSpec} from '../types/endpointSpec.js';

/**
 * Internal constructors for SDK-authored endpoint/assertion objects.
 *
 * These functions attach hidden symbol markers so TypeScript can distinguish
 * values created by SDK helpers from plain object literals with similar
 * shapes. They are intentionally kept behind the public helper objects
 * (`http`, `tool`, `artifact`, etc.) instead of being package exports.
 */

/** Create a branded endpoint from an author-provided endpoint spec. */
export function createEndpoint(spec: EndpointSpec): Endpoint {
  return {...spec, [ENDPOINT_BRAND]: true} as Endpoint;
}

/** Create an `http.called` assertion for a declared endpoint key. */
export function createHttpCalledAssertion<K extends string>(
  endpoint: K,
  opts?: {status?: number},
): CalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'http.called' as const,
    endpoint,
  };
  return opts?.status === undefined
    ? (base as CalledAssertion<K>)
    : ({...base, status: opts.status} as CalledAssertion<K>);
}

/** Create an `http.notCalled` assertion for a declared endpoint key. */
export function createHttpNotCalledAssertion<K extends string>(
  endpoint: K,
): NotCalledAssertion<K> {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'http.notCalled' as const,
    endpoint,
  };
}

/** Create a positive tool-use assertion, optionally scoped by shell matcher. */
export function createToolCalledAssertion<K extends ToolKind>(
  tool: K,
  matcher?: ShellCommandMatcher | ToolPathMatcher,
): ToolCalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'tool.called' as const,
    tool,
  };
  return (matcher === undefined
    ? base
    : 'path' in matcher
      ? {...base, ...matcher}
      : {...base, command: matcher}) as unknown as ToolCalledAssertion<K>;
}

/** Create a negative tool-use assertion, optionally scoped by shell matcher. */
export function createToolNotCalledAssertion<K extends ToolKind>(
  tool: K,
  matcher?: ShellCommandMatcher | ToolPathMatcher,
): ToolNotCalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'tool.notCalled' as const,
    tool,
  };
  return (matcher === undefined
    ? base
    : 'path' in matcher
      ? {...base, ...matcher}
      : {...base, command: matcher}) as unknown as ToolNotCalledAssertion<K>;
}

/** Create a positive normalized command assertion. */
export function createCommandCalledAssertion(
  executable: string,
  matcher?: CommandMatcher,
): CommandCalledAssertion {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'command.called' as const,
    executable,
  };
  return matcher === undefined ? base : {...base, command: matcher};
}

/** Create a negative normalized command assertion. */
export function createCommandNotCalledAssertion(
  executable: string,
  matcher?: CommandMatcher,
): CommandNotCalledAssertion {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'command.notCalled' as const,
    executable,
  };
  return matcher === undefined ? base : {...base, command: matcher};
}

/** Create a post-harness verification command assertion. */
export function createVerifyCommandAssertion(
  command: string,
  opts: VerifyCommandOptions = {},
): VerifyCommandAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'verify.command' as const,
    command,
    ...opts,
  };
}

/** Create an assertion that a path exists in the scenario work directory. */
export function createArtifactExistsAssertion(
  path: string,
): ArtifactExistsAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'artifact.exists' as const,
    path,
  };
}

/** Create an assertion that a file contains expected text. */
export function createArtifactContainsAssertion(
  path: string,
  text: string,
): ArtifactContainsAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'artifact.contains' as const,
    path,
    text,
  };
}

/** Create an assertion over the full harness transcript text. */
export function createTranscriptContainsAssertion(
  text: string,
): TranscriptContainsAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'transcript.contains' as const,
    text,
  };
}

/** Create an assertion over the extracted final assistant message. */
export function createFinalMessageContainsAssertion(
  text: string,
): FinalMessageContainsAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'finalMessage.contains' as const,
    text,
  };
}

/** Create an ordered sequence assertion from positive tool-call steps. */
export function createSequenceInOrderAssertion(
  steps: readonly SequenceStepAssertion[],
): SequenceInOrderAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'sequence.inOrder' as const,
    steps,
  };
}

/** Create a union assertion that passes when any branch passes. */
export function createAnyOfAssertion<K extends string>(
  steps: readonly AnyOfBranchAssertion<K>[],
): AnyOfAssertion<K> {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'anyOf' as const,
    steps,
  };
}

/** Create an assertion that a named skill instruction file was referenced. */
export function createSkillReferencedAssertion(
  skill: string,
): SkillReferencedAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'skill.referenced' as const,
    skill,
  };
}
