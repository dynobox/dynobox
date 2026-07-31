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
  lastMatch: 'none' | 'event' | 'paired-mock' | 'unpaired-mock';
};

const UNPAIRED_MOCK_ORDER_ERROR =
  'Cannot determine order for an unpaired CLI mock call relative to unrelated harness tool events.';

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
  const allowUnpairedMocks = assertion.steps.every(
    (step) => step.type === 'command.called',
  );
  const matchedEvents: (ToolEvent | ObservedCommand)[] = [];
  let cursor: SequenceCursor = {
    eventIndex: 0,
    shellOffset: 0,
    commandOffset: 0,
    mockCallOffset: 0,
    lastMatch: 'none',
  };

  for (const [stepIndex, step] of assertion.steps.entries()) {
    const match = findMatchingSequenceStep(
      step,
      toolEvents,
      observedCommands,
      cursor,
      allowUnpairedMocks,
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
  allowUnpairedMocks: boolean,
): {
  event?: ToolEvent | ObservedCommand;
  nextCursor?: SequenceCursor;
  error?: string;
} {
  if (step.type === 'command.called') {
    const mockMatches = observedCommands
      .filter(
        (command) =>
          command.cliMockCallIndex !== undefined &&
          command.cliMockCallIndex >= cursor.mockCallOffset &&
          commandMatchesAssertion(command, step),
      )
      .sort((left, right) => left.cliMockCallIndex! - right.cliMockCallIndex!);
    const orderableMockMatches = allowUnpairedMocks
      ? mockMatches
      : mockMatches.filter((command) => command.cliMockEventPaired === true);
    // Mock-backed command steps can always be ordered against one another by
    // invocation index, even when a nested call has no shell event to anchor it.
    const lastMatchWasMock = cursor.lastMatch.endsWith('mock');
    const nonMockMatches = observedCommands.filter(
      (command) =>
        command.cliMockCallIndex === undefined &&
        commandAfterCursor(command, cursor) &&
        commandMatchesAssertion(command, step),
    );
    if (!allowUnpairedMocks) {
      const eventMatch = [
        ...orderableMockMatches.filter(
          (command) =>
            cursor.lastMatch === 'none' ||
            lastMatchWasMock ||
            commandAfterCursor(command, cursor),
        ),
        ...nonMockMatches,
      ].sort(compareCommandPosition)[0];
      if (eventMatch !== undefined) {
        return commandSequenceMatch(eventMatch, cursor);
      }
      if (mockMatches.some((command) => command.cliMockEventPaired === false)) {
        return {error: UNPAIRED_MOCK_ORDER_ERROR};
      }
      return {};
    }
    const mockMatch =
      cursor.lastMatch === 'none' || lastMatchWasMock
        ? orderableMockMatches[0]
        : orderableMockMatches.find(
            (command) =>
              command.cliMockEventPaired === true &&
              commandAfterCursor(command, cursor),
          );
    if (mockMatch !== undefined) {
      return commandSequenceMatch(mockMatch, cursor);
    }
    const nonMockMatch = nonMockMatches[0];
    if (nonMockMatch !== undefined) {
      if (cursor.lastMatch === 'unpaired-mock') {
        return {error: UNPAIRED_MOCK_ORDER_ERROR};
      }
      return commandSequenceMatch(nonMockMatch, cursor);
    }
    if (
      cursor.lastMatch === 'event' &&
      mockMatches.some((command) => command.cliMockEventPaired === false)
    ) {
      return {error: UNPAIRED_MOCK_ORDER_ERROR};
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
      if (cursor.lastMatch === 'unpaired-mock') {
        return {error: UNPAIRED_MOCK_ORDER_ERROR};
      }
      return {
        event,
        nextCursor: {
          eventIndex: index + 1,
          shellOffset: 0,
          commandOffset: 0,
          mockCallOffset: cursor.mockCallOffset,
          lastMatch: 'event',
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
    if (cursor.lastMatch === 'unpaired-mock') {
      return {error: UNPAIRED_MOCK_ORDER_ERROR};
    }

    return {
      event,
      nextCursor: {
        eventIndex: index,
        shellOffset: match.end,
        commandOffset: index === cursor.eventIndex ? cursor.commandOffset : 0,
        mockCallOffset: cursor.mockCallOffset,
        lastMatch: 'event',
      },
    };
  }

  return {};
}

function commandSequenceMatch(
  command: ObservedCommand,
  cursor: SequenceCursor,
): {event: ObservedCommand; nextCursor: SequenceCursor} {
  if (command.cliMockCallIndex === undefined) {
    return {
      event: command,
      nextCursor: {
        eventIndex: command.eventIndex,
        shellOffset: command.end,
        commandOffset: command.segmentIndex + 1,
        mockCallOffset: cursor.mockCallOffset,
        lastMatch: 'event',
      },
    };
  }

  const paired = command.cliMockEventPaired === true;
  return {
    event: command,
    nextCursor: {
      eventIndex: paired ? command.eventIndex : cursor.eventIndex,
      shellOffset: paired ? command.end : cursor.shellOffset,
      commandOffset: paired ? command.segmentIndex + 1 : cursor.commandOffset,
      mockCallOffset: command.cliMockCallIndex + 1,
      lastMatch: paired ? 'paired-mock' : 'unpaired-mock',
    },
  };
}

function compareCommandPosition(
  left: ObservedCommand,
  right: ObservedCommand,
): number {
  return (
    left.eventIndex - right.eventIndex ||
    left.segmentIndex - right.segmentIndex ||
    left.start - right.start
  );
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
