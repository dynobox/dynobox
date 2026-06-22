import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  commandMatchesAssertion,
  describeCommandStep,
  extractObservedCommands,
  type ObservedCommand,
} from './commandAssertions.js';
import {pathStringsFromToolInput} from './inspection.js';
import {
  describeShellMatcher,
  shellCommandMatches,
  shellCommandMatchPosition,
  validateRegexMatcher,
} from './shellMatcher.js';
import type {AssertionResult, ToolEvent} from './types.js';

type ToolCalledAssertion = Extract<IrAssertion, {kind: 'tool.called'}>;
type ToolCalledStep = Omit<ToolCalledAssertion, 'id'>;
type CommandCalledStep = Omit<
  Extract<IrAssertion, {kind: 'command.called'}>,
  'id'
>;
export type SequenceEvidence = ToolEvent | ObservedCommand;
type SequenceStep = ToolCalledStep | CommandCalledStep;
type ToolNotCalledStep = Omit<
  Extract<IrAssertion, {kind: 'tool.notCalled'}>,
  'id'
>;

type SequenceCursor = {
  eventIndex: number;
  shellOffset: number;
  commandOffset: number;
};

type SequenceStepMatch = {
  evidence: SequenceEvidence;
  nextCursor: SequenceCursor;
};

export function evaluateToolCalledAssertion(
  assertion: ToolCalledAssertion,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const match = findMatchingToolEvent(assertion, toolEvents);

  if (match.error !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: match.error,
    };
  }

  if (match.event !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: toolCalledPassMessage(assertion),
      evidence: match.event,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message: toolCalledFailMessage(assertion),
  };
}

export function evaluateToolNotCalledAssertion(
  assertion: Extract<IrAssertion, {kind: 'tool.notCalled'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const match = findMatchingToolEvent(assertion, toolEvents);

  if (match.error !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: match.error,
    };
  }

  if (match.event !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: toolNotCalledFailMessage(assertion),
      evidence: match.event,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: true,
    message: toolNotCalledPassMessage(assertion),
  };
}

export function evaluateSequenceInOrder(
  assertion: Extract<IrAssertion, {kind: 'sequence.inOrder'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const observedCommands = extractObservedCommands(toolEvents);
  const cursor: SequenceCursor = {
    eventIndex: 0,
    shellOffset: 0,
    commandOffset: 0,
  };
  const match = matchSequenceFrom(
    assertion.steps,
    0,
    toolEvents,
    observedCommands,
    cursor,
    [],
  );

  if (match.error !== undefined || match.evidence === undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: match.error ?? 'Expected ordered tool steps to match.',
      evidence: match.evidence,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: true,
    message: `Observed ${assertion.steps.length} ordered tool steps.`,
    evidence: match.evidence,
  };
}

function matchSequenceFrom(
  steps: readonly SequenceStep[],
  stepIndex: number,
  toolEvents: readonly ToolEvent[],
  observedCommands: readonly ObservedCommand[],
  cursor: SequenceCursor,
  evidence: readonly SequenceEvidence[],
): {evidence?: SequenceEvidence[]; error?: string} {
  if (stepIndex >= steps.length) return {evidence: [...evidence]};

  const step = steps[stepIndex]!;
  const candidates = findMatchingSequenceStepCandidates(
    step,
    toolEvents,
    observedCommands,
    cursor,
  );
  if (candidates.error !== undefined) {
    return {error: candidates.error, evidence: [...evidence]};
  }
  if (candidates.matches.length === 0) {
    return {
      error: `Expected ordered step #${stepIndex + 1} (${describeSequenceStep(step)}) to match an observed tool event, but none was observed after the previous step.`,
      evidence: [...evidence],
    };
  }

  let failedMatch: {evidence?: SequenceEvidence[]; error?: string} | undefined;
  for (const candidate of candidates.matches) {
    const next = matchSequenceFrom(
      steps,
      stepIndex + 1,
      toolEvents,
      observedCommands,
      candidate.nextCursor,
      [...evidence, candidate.evidence],
    );
    if (next.error === undefined && next.evidence !== undefined) return next;
    failedMatch = next;
  }

  return failedMatch ?? {evidence: [...evidence]};
}

function findMatchingSequenceStepCandidates(
  step: SequenceStep,
  toolEvents: readonly ToolEvent[],
  observedCommands: readonly ObservedCommand[],
  cursor: SequenceCursor,
): {
  matches: SequenceStepMatch[];
  error?: string;
} {
  if (step.kind === 'command.called') {
    const matches: SequenceStepMatch[] = [];
    for (const command of observedCommands) {
      if (command.eventIndex < cursor.eventIndex) continue;
      if (
        command.eventIndex === cursor.eventIndex &&
        (command.segmentIndex < cursor.commandOffset ||
          command.end <= cursor.shellOffset)
      ) {
        continue;
      }
      if (!commandMatchesAssertion(command, step)) continue;
      matches.push({
        evidence: command,
        nextCursor: {
          eventIndex: command.eventIndex,
          shellOffset: command.end,
          commandOffset: command.segmentIndex + 1,
        },
      });
    }
    return {matches};
  }

  if (step.matcher !== undefined) {
    const invalidRegex = validateRegexMatcher(step.matcher);
    if (invalidRegex !== undefined) return {matches: [], error: invalidRegex};
  }

  const matches: SequenceStepMatch[] = [];
  for (let index = cursor.eventIndex; index < toolEvents.length; index += 1) {
    const event = toolEvents[index]!;
    if (event.kind !== step.toolKind) continue;

    if (step.matcher === undefined) {
      if (
        index === cursor.eventIndex &&
        event.kind === 'shell' &&
        (cursor.shellOffset > 0 || cursor.commandOffset > 0)
      ) {
        continue;
      }

      if (
        step.pathMatcher !== undefined &&
        !toolEventMatchesPath(event, step.pathMatcher.path)
      ) {
        continue;
      }
      matches.push({
        evidence: event,
        nextCursor: {eventIndex: index + 1, shellOffset: 0, commandOffset: 0},
      });
      continue;
    }

    if (event.kind !== 'shell' || typeof event.command !== 'string') continue;

    const startAt = index === cursor.eventIndex ? cursor.shellOffset : 0;
    const match = shellCommandMatchPosition(
      event.command,
      step.matcher,
      startAt,
    );
    if (!match.passed) {
      if (match.error !== undefined) return {matches: [], error: match.error};
      continue;
    }

    matches.push({
      evidence: event,
      nextCursor: {
        eventIndex: index,
        shellOffset: match.end,
        commandOffset: index === cursor.eventIndex ? cursor.commandOffset : 0,
      },
    });
  }

  return {matches};
}

function findMatchingToolEvent(
  assertion: ToolCalledStep | ToolNotCalledStep,
  toolEvents: readonly ToolEvent[],
  startIndex = 0,
): {event?: ToolEvent; index?: number; error?: string} {
  if (assertion.matcher !== undefined) {
    const invalidRegex = validateRegexMatcher(assertion.matcher);
    if (invalidRegex !== undefined) return {error: invalidRegex};
  }

  for (let index = startIndex; index < toolEvents.length; index += 1) {
    const event = toolEvents[index]!;
    if (!toolEventMatchesAssertion(event, assertion)) continue;
    return {event, index};
  }

  return {};
}

function toolEventMatchesAssertion(
  event: ToolEvent,
  assertion: ToolCalledStep | ToolNotCalledStep,
): boolean {
  if (event.kind !== assertion.toolKind) return false;
  if (assertion.pathMatcher !== undefined) {
    return toolEventMatchesPath(event, assertion.pathMatcher.path);
  }
  if (assertion.matcher === undefined) return true;
  if (event.kind !== 'shell' || typeof event.command !== 'string') return false;
  return shellCommandMatches(event.command, assertion.matcher).passed;
}

function toolCalledPassMessage(assertion: ToolCalledStep): string {
  if (assertion.pathMatcher !== undefined) {
    return `Observed tool "${assertion.toolKind}" with path "${assertion.pathMatcher.path}".`;
  }
  if (assertion.matcher === undefined) {
    return `Observed tool "${assertion.toolKind}".`;
  }
  return `Observed shell command matching ${describeShellMatcher(assertion.matcher)}.`;
}

function toolCalledFailMessage(assertion: ToolCalledStep): string {
  if (assertion.pathMatcher !== undefined) {
    return `Expected tool "${assertion.toolKind}" with path "${assertion.pathMatcher.path}" to be called, but observed none.`;
  }
  if (assertion.matcher === undefined) {
    return `Expected tool "${assertion.toolKind}" to be called, but observed none.`;
  }
  return `Expected shell command matching ${describeShellMatcher(assertion.matcher)}, but no matching shell command was observed.`;
}

function toolNotCalledPassMessage(assertion: ToolNotCalledStep): string {
  if (assertion.pathMatcher !== undefined) {
    return `Observed no tool "${assertion.toolKind}" calls with path "${assertion.pathMatcher.path}".`;
  }
  if (assertion.matcher === undefined) {
    return `Observed no tool "${assertion.toolKind}" calls.`;
  }
  return `Observed no shell command matching ${describeShellMatcher(assertion.matcher)}.`;
}

function toolNotCalledFailMessage(assertion: ToolNotCalledStep): string {
  if (assertion.pathMatcher !== undefined) {
    return `Expected tool "${assertion.toolKind}" not to be called with path "${assertion.pathMatcher.path}", but observed a matching call.`;
  }
  if (assertion.matcher === undefined) {
    return `Expected tool "${assertion.toolKind}" not to be called, but observed a matching call.`;
  }
  return `Expected no shell command matching ${describeShellMatcher(assertion.matcher)}, but observed a matching command.`;
}

function describeToolStep(step: ToolCalledStep): string {
  if (step.pathMatcher !== undefined) {
    return `tool.called(${step.toolKind}, path "${step.pathMatcher.path}")`;
  }
  if (step.matcher === undefined) return `tool.called(${step.toolKind})`;
  return `tool.called(${step.toolKind}, ${describeShellMatcher(step.matcher)})`;
}

function describeSequenceStep(step: SequenceStep): string {
  if (step.kind === 'command.called') return describeCommandStep(step);
  return describeToolStep(step);
}

function toolEventMatchesPath(event: ToolEvent, expectedPath: string): boolean {
  const expected = normalizePathForMatch(expectedPath);
  return pathStringsFromToolInput(event.input).some((value) => {
    const actual = normalizePathForMatch(value);
    return actual === expected || actual.endsWith(`/${expected}`);
  });
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}
