import {type IrAssertion, irAssertionFromNode} from '@dynobox/sdk/ir';

import {
  evaluateArtifactContains,
  evaluateArtifactExists,
} from './artifactAssertions.js';
import {
  evaluateCommandCalledAssertion,
  evaluateCommandNotCalledAssertion,
} from './commandAssertions.js';
import {evaluateHttpCalled, evaluateHttpNotCalled} from './httpAssertions.js';
import {passed, unsupportedAssertionResult} from './results.js';
import {evaluateSkillReferenced} from './skillAssertions.js';
import {evaluateTextContains} from './textAssertions.js';
import {
  evaluateSequenceInOrder,
  evaluateToolCalledAssertion,
  evaluateToolNotCalledAssertion,
} from './toolAssertions.js';
import type {AssertionResult, EvaluationInput} from './types.js';
import {evaluateVerifyCommandAssertion} from './verifyAssertions.js';

export type {ObservedCommand} from './commandAssertions.js';
export {extractObservedCommands} from './commandAssertions.js';
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
  VerifyCommandResult,
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

  if (assertion.kind === 'command.called') {
    return evaluateCommandCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.kind === 'command.notCalled') {
    return evaluateCommandNotCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.kind === 'verify.command') {
    return evaluateVerifyCommandAssertion(
      assertion,
      input.verifyCommandResults,
    );
  }

  if (assertion.kind === 'sequence.inOrder') {
    return evaluateSequenceInOrder(assertion, input.toolEvents);
  }

  if (assertion.kind === 'anyOf') {
    return evaluateAnyOf(assertion, input);
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

/**
 * Evaluate every `anyOf` branch, then report the lowest-index passing branch.
 * Branches are always fully evaluated; evaluation does not short-circuit after
 * the first match.
 */
function evaluateAnyOf(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>,
  input: EvaluationInput,
): AssertionResult {
  const branchResults = assertion.steps.map((step, index) =>
    evaluateAssertion(
      irAssertionFromNode(`${assertion.id}.branch.${index + 1}`, step),
      input,
    ),
  );
  const matchedIndex = branchResults.findIndex((result) => result.passed);

  if (matchedIndex !== -1) {
    const matched = branchResults[matchedIndex]!;
    return passed(
      assertion,
      `Matched anyOf branch #${matchedIndex + 1}: ${matched.message}`,
      {
        kind: 'anyOf',
        branchIndex: matchedIndex + 1,
        branches: branchResults,
      },
    );
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message: [
      `Expected anyOf to match at least one branch, but all ${branchResults.length} branches failed.`,
      ...branchResults.map(
        (result, index) => `Branch #${index + 1}: ${result.message}`,
      ),
    ].join('\n'),
    evidence: {
      kind: 'anyOf',
      branches: branchResults,
    },
  };
}
