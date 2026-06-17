import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  evaluateArtifactContains,
  evaluateArtifactExists,
} from './artifactAssertions.js';
import {evaluateHttpCalled, evaluateHttpNotCalled} from './httpAssertions.js';
import {unsupportedAssertionResult} from './results.js';
import {evaluateSkillReferenced} from './skillAssertions.js';
import {evaluateTextContains} from './textAssertions.js';
import {
  evaluateSequenceInOrder,
  evaluateToolCalledAssertion,
  evaluateToolNotCalledAssertion,
} from './toolAssertions.js';
import type {AssertionResult, EvaluationInput} from './types.js';

export type {ArtifactInspection} from './inspection.js';
export {
  extractSkillFiles,
  inspectArtifact,
  stringsFromUnknown,
} from './inspection.js';
export type {
  AssertionResult,
  EvaluationInput,
  HttpEvent,
  ToolEvent,
} from './types.js';

/** Evaluate a scenario's compiled IR assertions against observed harness output. */
export function evaluateAssertions(input: EvaluationInput): AssertionResult[] {
  return input.assertions.map((assertion) =>
    evaluateAssertion(assertion, input),
  );
}

function evaluateAssertion(
  assertion: IrAssertion,
  input: EvaluationInput,
): AssertionResult {
  if (assertion.kind === 'tool.called') {
    return evaluateToolCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.kind === 'tool.notCalled') {
    return evaluateToolNotCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.kind === 'sequence.inOrder') {
    return evaluateSequenceInOrder(assertion, input.toolEvents);
  }

  if (assertion.kind === 'skill.referenced') {
    return evaluateSkillReferenced(assertion, input.toolEvents);
  }

  if (assertion.kind === 'http.called') {
    return evaluateHttpCalled(assertion, input.httpEvents ?? []);
  }

  if (assertion.kind === 'http.notCalled') {
    return evaluateHttpNotCalled(assertion, input.httpEvents ?? []);
  }

  if (assertion.kind === 'artifact.exists') {
    return evaluateArtifactExists(assertion, input.workDir);
  }

  if (assertion.kind === 'artifact.contains') {
    return evaluateArtifactContains(assertion, input.workDir);
  }

  if (assertion.kind === 'transcript.contains') {
    return evaluateTextContains({
      assertionId: assertion.id,
      kind: assertion.kind,
      label: 'transcript',
      actual: input.transcript,
      expected: assertion.text,
    });
  }

  if (assertion.kind === 'finalMessage.contains') {
    return evaluateTextContains({
      assertionId: assertion.id,
      kind: assertion.kind,
      label: 'final message',
      actual: input.finalMessage,
      expected: assertion.text,
    });
  }

  return unsupportedAssertionResult(assertion);
}
