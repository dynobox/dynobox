import {type IrAssertion, irAssertionFromNode} from '@dynobox/sdk/ir';

import {
  captureArtifactBaseline,
  evaluateArtifactContains,
  evaluateArtifactExists,
  evaluateArtifactNotExists,
  evaluateArtifactUnchanged,
} from './artifactAssertions.js';
import {anyOfBranchId, collectArtifactUnchangedTargets} from './collect.js';
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
import type {
  ArtifactBaseline,
  AssertionResult,
  EvaluationInput,
} from './types.js';
import {evaluateVerifyCommandAssertion} from './verifyAssertions.js';

export {
  captureArtifactBaseline,
  evaluateArtifactContains,
  evaluateArtifactExists,
  evaluateArtifactNotExists,
  evaluateArtifactUnchanged,
} from './artifactAssertions.js';
export type {ArtifactUnchangedTarget} from './collect.js';
export {
  anyOfBranchId,
  anyOfHasVerifyBranch,
  assertionRequiresVerify,
  collectArtifactUnchangedTargets,
  collectVerifyCommandAssertions,
} from './collect.js';
export type {ObservedCommand} from './commandAssertions.js';
export {extractObservedCommands} from './commandAssertions.js';
export type {ArtifactInspection} from './inspection.js';
export {
  extractSkillFiles,
  inspectArtifact,
  stringsFromUnknown,
} from './inspection.js';
export {
  describeCommandMatcher,
  describeShellCommandMatcher,
  type MatcherPresentationStyle,
  type ShellCommandMatcherEntry,
  shellCommandMatcherEntry,
} from './presentation.js';
export type {
  ArtifactBaseline,
  ArtifactPathState,
  ArtifactUnchangedEvidence,
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

/**
 * Pre-evaluate non-verification `anyOf` branches so later verification commands
 * cannot mutate the workdir and change observation branch outcomes.
 */
export function preEvaluateAnyOfObservationBranches(
  assertions: readonly IrAssertion[],
  input: Omit<
    EvaluationInput,
    'assertions' | 'verifyCommandResults' | 'anyOfObservationBranches'
  >,
): Map<string, (AssertionResult | undefined)[]> {
  const cache = new Map<string, (AssertionResult | undefined)[]>();
  const evaluationInput: EvaluationInput = {
    ...input,
    assertions: [],
  };

  for (const assertion of assertions) {
    if (assertion.type !== 'anyOf') continue;

    cache.set(
      assertion.id,
      assertion.steps.map((step, index) => {
        if (step.type === 'verify.command') return undefined;
        return evaluateAssertion(
          irAssertionFromNode(anyOfBranchId(assertion.id, index + 1), step),
          evaluationInput,
        );
      }),
    );
  }

  return cache;
}

/**
 * Capture baselines for every `artifact.unchanged` target, including nested
 * anyOf branches. Snapshot failures stay in the map as assertion-level data.
 */
export function captureArtifactBaselines(
  assertions: readonly IrAssertion[],
  workDir: string | undefined,
): Map<string, ArtifactBaseline> {
  const baselines = new Map<string, ArtifactBaseline>();
  for (const target of collectArtifactUnchangedTargets(assertions)) {
    baselines.set(
      target.assertionId,
      captureArtifactBaseline(target.path, workDir),
    );
  }
  return baselines;
}

function evaluateAssertion(
  assertion: IrAssertion,
  input: EvaluationInput,
): AssertionResult {
  if (assertion.type === 'tool.called') {
    return evaluateToolCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.type === 'tool.notCalled') {
    return evaluateToolNotCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.type === 'command.called') {
    return evaluateCommandCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.type === 'command.notCalled') {
    return evaluateCommandNotCalledAssertion(assertion, input.toolEvents);
  }

  if (assertion.type === 'verify.command') {
    return evaluateVerifyCommandAssertion(
      assertion,
      input.verifyCommandResults,
    );
  }

  if (assertion.type === 'sequence.inOrder') {
    return evaluateSequenceInOrder(assertion, input.toolEvents);
  }

  if (assertion.type === 'anyOf') {
    return evaluateAnyOf(assertion, input);
  }

  if (assertion.type === 'skill.referenced') {
    return evaluateSkillReferenced(assertion, input.toolEvents);
  }

  if (assertion.type === 'http.called') {
    return evaluateHttpCalled(assertion, input.httpEvents ?? []);
  }

  if (assertion.type === 'http.notCalled') {
    return evaluateHttpNotCalled(assertion, input.httpEvents ?? []);
  }

  if (assertion.type === 'artifact.exists') {
    return evaluateArtifactExists(assertion, input.workDir);
  }

  if (assertion.type === 'artifact.notExists') {
    return evaluateArtifactNotExists(assertion, input.workDir);
  }

  if (assertion.type === 'artifact.contains') {
    return evaluateArtifactContains(assertion, input.workDir);
  }

  if (assertion.type === 'artifact.unchanged') {
    return evaluateArtifactUnchanged(
      assertion,
      input.workDir,
      input.artifactBaselines,
    );
  }

  if (assertion.type === 'transcript.contains') {
    return evaluateTextContains({
      assertionId: assertion.id,
      type: assertion.type,
      label: 'transcript',
      actual: input.transcript,
      expected: assertion.text,
    });
  }

  if (assertion.type === 'finalMessage.contains') {
    return evaluateTextContains({
      assertionId: assertion.id,
      type: assertion.type,
      label: 'final message',
      actual: input.finalMessage,
      expected: assertion.text,
    });
  }

  return unsupportedAssertionResult(assertion);
}

/**
 * Evaluate every `anyOf` branch, then report the lowest-index passing branch.
 * Observation branches may be supplied from a pre-evaluation cache so nested
 * verification commands cannot retroactively change artifact outcomes.
 * Branches are always fully evaluated; evaluation does not short-circuit after
 * the first match.
 */
function evaluateAnyOf(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>,
  input: EvaluationInput,
): AssertionResult {
  const cached = input.anyOfObservationBranches?.get(assertion.id);
  const branchResults = assertion.steps.map((step, index) => {
    const branchAssertion = irAssertionFromNode(
      anyOfBranchId(assertion.id, index + 1),
      step,
    );

    if (step.type !== 'verify.command' && cached?.[index] !== undefined) {
      return cached[index]!;
    }

    return evaluateAssertion(branchAssertion, input);
  });
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
    type: assertion.type,
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
