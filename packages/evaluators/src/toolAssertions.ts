import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  commandMatchesAssertion,
  type CommandObservationOptions,
  describeCommandStep,
  extractObservedCommands,
  type ObservedCommand,
} from './commandAssertions.js';
import {pathStringsFromToolInput} from './inspection.js';
import {passed} from './results.js';
import {
  describeShellMatcher,
  shellCommandMatches,
  shellCommandMatchPosition,
  validateRegexMatcher,
} from './shellMatcher.js';
import type {AssertionResult, ToolEvent} from './types.js';

type ToolCalledAssertion = Extract<IrAssertion, {type: 'tool.called'}>;
type ToolCalledStep = Omit<ToolCalledAssertion, 'id'>;
type CommandCalledStep = Omit<
  Extract<IrAssertion, {type: 'command.called'}>,
  'id'
>;
type SequenceStep = ToolCalledStep | CommandCalledStep;
type ToolNotCalledStep = Omit<
  Extract<IrAssertion, {type: 'tool.notCalled'}>,
  'id'
>;

type SequenceCursor = {
  eventIndex: number;
  shellOffset: number;
  commandOffset: number;
  mockCallOffset: number;
  lastMatchWasMock: boolean;
};

export function evaluateToolCalledAssertion(
  assertion: ToolCalledAssertion,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const match = findMatchingToolEvent(assertion, toolEvents);

  if (match.error !== undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: match.error,
    };
  }

  if (match.event !== undefined) {
    return passed(assertion, toolCalledPassMessage(assertion), match.event);
  }

  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed: false,
    message: toolCalledFailMessage(assertion),
  };
}

export function evaluateToolNotCalledAssertion(
  assertion: Extract<IrAssertion, {type: 'tool.notCalled'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const match = findMatchingToolEvent(assertion, toolEvents);

  if (match.error !== undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: match.error,
    };
  }

  if (match.event !== undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: toolNotCalledFailMessage(assertion),
      evidence: match.event,
    };
  }

  return passed(assertion, toolNotCalledPassMessage(assertion));
}

export function evaluateSequenceInOrder(
  assertion: Extract<IrAssertion, {type: 'sequence.inOrder'}>,
  toolEvents: readonly ToolEvent[],
  options?: CommandObservationOptions,
): AssertionResult {
  const observedCommands = extractObservedCommands(toolEvents, options);
  const matchedEvents: (ToolEvent | ObservedCommand)[] = [];
  let cursor: SequenceCursor = {
    eventIndex: 0,
    shellOffset: 0,
    commandOffset: 0,
    mockCallOffset: 0,
    lastMatchWasMock: false,
  };

  for (const [stepIndex, step] of assertion.steps.entries()) {
    const match = findMatchingSequenceStep(
      step,
      toolEvents,
      observedCommands,
      cursor,
    );
    if (match.error !== undefined) {
      return {
        assertionId: assertion.id,
        type: assertion.type,
        passed: false,
        message: match.error,
      };
    }

    if (match.event === undefined || match.nextCursor === undefined) {
      return {
        assertionId: assertion.id,
        type: assertion.type,
        passed: false,
        message: `Expected ordered step #${stepIndex + 1} (${describeSequenceStep(step)}) to match an observed tool event, but none was observed after the previous step.`,
        evidence: matchedEvents,
      };
    }

    matchedEvents.push(match.event);
    cursor = match.nextCursor;
  }

  return passed(
    assertion,
    `Observed ${assertion.steps.length} ordered tool steps.`,
    matchedEvents,
  );
}

function findMatchingSequenceStep(
  step: SequenceStep,
  toolEvents: readonly ToolEvent[],
  observedCommands: readonly ObservedCommand[],
  cursor: SequenceCursor,
): {
  event?: ToolEvent | ObservedCommand;
  nextCursor?: SequenceCursor;
  error?: string;
} {
  if (step.type === 'command.called') {
    const mockMatch = observedCommands
      .filter(
        (command) =>
          command.cliMockCallIndex !== undefined &&
          command.cliMockCallIndex >= cursor.mockCallOffset &&
          (cursor.lastMatchWasMock || commandAfterCursor(command, cursor)) &&
          commandMatchesAssertion(command, step),
      )
      .sort(
        (left, right) => left.cliMockCallIndex! - right.cliMockCallIndex!,
      )[0];
    if (mockMatch !== undefined) {
      return {
        event: mockMatch,
        nextCursor: {
          eventIndex: mockMatch.eventIndex,
          shellOffset: mockMatch.end,
          commandOffset: mockMatch.segmentIndex + 1,
          mockCallOffset: mockMatch.cliMockCallIndex! + 1,
          lastMatchWasMock: true,
        },
      };
    }

    for (const command of observedCommands) {
      if (command.cliMockCallIndex !== undefined) continue;
      if (!commandAfterCursor(command, cursor)) continue;
      if (!commandMatchesAssertion(command, step)) continue;
      return {
        event: command,
        nextCursor: {
          eventIndex: command.eventIndex,
          shellOffset: command.end,
          commandOffset: command.segmentIndex + 1,
          mockCallOffset: cursor.mockCallOffset,
          lastMatchWasMock: false,
        },
      };
    }
    return {};
  }

  if (step.command !== undefined) {
    const invalidRegex = validateRegexMatcher(step.command);
    if (invalidRegex !== undefined) return {error: invalidRegex};
  }

  for (let index = cursor.eventIndex; index < toolEvents.length; index += 1) {
    const event = toolEvents[index]!;
    if (event.kind !== step.tool) continue;

    if (step.command === undefined) {
      if (
        index === cursor.eventIndex &&
        event.kind === 'shell' &&
        (cursor.shellOffset > 0 || cursor.commandOffset > 0)
      ) {
        continue;
      }

      if (step.path !== undefined && !toolEventMatchesPath(event, step.path)) {
        continue;
      }
      return {
        event,
        nextCursor: {
          eventIndex: index + 1,
          shellOffset: 0,
          commandOffset: 0,
          mockCallOffset: cursor.mockCallOffset,
          lastMatchWasMock: false,
        },
      };
    }

    if (event.kind !== 'shell' || typeof event.command !== 'string') continue;

    const startAt = index === cursor.eventIndex ? cursor.shellOffset : 0;
    const match = shellCommandMatchPosition(
      event.command,
      step.command,
      startAt,
    );
    if (!match.passed) {
      if (match.error !== undefined) return {error: match.error};
      continue;
    }

    return {
      event,
      nextCursor: {
        eventIndex: index,
        shellOffset: match.end,
        commandOffset: index === cursor.eventIndex ? cursor.commandOffset : 0,
        mockCallOffset: cursor.mockCallOffset,
        lastMatchWasMock: false,
      },
    };
  }

  return {};
}

function commandAfterCursor(
  command: ObservedCommand,
  cursor: SequenceCursor,
): boolean {
  if (command.eventIndex < cursor.eventIndex) return false;
  if (command.eventIndex > cursor.eventIndex) return true;
  return (
    command.segmentIndex >= cursor.commandOffset &&
    command.end > cursor.shellOffset
  );
}

function findMatchingToolEvent(
  assertion: ToolCalledStep | ToolNotCalledStep,
  toolEvents: readonly ToolEvent[],
  startIndex = 0,
): {event?: ToolEvent; index?: number; error?: string} {
  if (assertion.command !== undefined) {
    const invalidRegex = validateRegexMatcher(assertion.command);
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
  if (event.kind !== assertion.tool) return false;
  if (assertion.path !== undefined) {
    return toolEventMatchesPath(event, assertion.path);
  }
  if (assertion.command === undefined) return true;
  if (event.kind !== 'shell' || typeof event.command !== 'string') return false;
  return shellCommandMatches(event.command, assertion.command).passed;
}

function toolCalledPassMessage(assertion: ToolCalledStep): string {
  if (assertion.path !== undefined) {
    return `Observed tool "${assertion.tool}" with path "${assertion.path}".`;
  }
  if (assertion.command === undefined) {
    return `Observed tool "${assertion.tool}".`;
  }
  return `Observed shell command matching ${describeShellMatcher(assertion.command)}.`;
}

function toolCalledFailMessage(assertion: ToolCalledStep): string {
  if (assertion.path !== undefined) {
    return `Expected tool "${assertion.tool}" with path "${assertion.path}" to be called, but observed none.`;
  }
  if (assertion.command === undefined) {
    return `Expected tool "${assertion.tool}" to be called, but observed none.`;
  }
  return `Expected shell command matching ${describeShellMatcher(assertion.command)}, but no matching shell command was observed.`;
}

function toolNotCalledPassMessage(assertion: ToolNotCalledStep): string {
  if (assertion.path !== undefined) {
    return `Observed no tool "${assertion.tool}" calls with path "${assertion.path}".`;
  }
  if (assertion.command === undefined) {
    return `Observed no tool "${assertion.tool}" calls.`;
  }
  return `Observed no shell command matching ${describeShellMatcher(assertion.command)}.`;
}

function toolNotCalledFailMessage(assertion: ToolNotCalledStep): string {
  if (assertion.path !== undefined) {
    return `Expected tool "${assertion.tool}" not to be called with path "${assertion.path}", but observed a matching call.`;
  }
  if (assertion.command === undefined) {
    return `Expected tool "${assertion.tool}" not to be called, but observed a matching call.`;
  }
  return `Expected no shell command matching ${describeShellMatcher(assertion.command)}, but observed a matching command.`;
}

function describeToolStep(step: ToolCalledStep): string {
  if (step.path !== undefined) {
    return `tool.called(${step.tool}, path "${step.path}")`;
  }
  if (step.command === undefined) return `tool.called(${step.tool})`;
  return `tool.called(${step.tool}, ${describeShellMatcher(step.command)})`;
}

function describeSequenceStep(step: SequenceStep): string {
  return step.type === 'command.called'
    ? describeCommandStep(step)
    : describeToolStep(step);
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
