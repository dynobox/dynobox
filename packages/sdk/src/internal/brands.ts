import type {
  ArtifactContainsAssertion,
  ArtifactExistsAssertion,
  CalledAssertion,
  Endpoint,
  FinalMessageContainsAssertion,
  NotCalledAssertion,
  SequenceInOrderAssertion,
  ShellCommandMatcher,
  SkillInvokedAssertion,
  ToolCalledAssertion,
  ToolKind,
  ToolNotCalledAssertion,
  TranscriptContainsAssertion,
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
  command?: ShellCommandMatcher,
): ToolCalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'tool.called' as const,
    tool,
  };
  return (command === undefined
    ? base
    : {...base, command}) as unknown as ToolCalledAssertion<K>;
}

/** Create a negative tool-use assertion, optionally scoped by shell matcher. */
export function createToolNotCalledAssertion<K extends ToolKind>(
  tool: K,
  command?: ShellCommandMatcher,
): ToolNotCalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    type: 'tool.notCalled' as const,
    tool,
  };
  return (command === undefined
    ? base
    : {...base, command}) as unknown as ToolNotCalledAssertion<K>;
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
  steps: readonly ToolCalledAssertion[],
): SequenceInOrderAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'sequence.inOrder' as const,
    steps,
  };
}

/** Create an assertion that a named skill instruction file was loaded. */
export function createSkillInvokedAssertion(
  skill: string,
): SkillInvokedAssertion {
  return {
    [ASSERTION_BRAND]: true as const,
    type: 'skill.invoked' as const,
    skill,
  };
}
