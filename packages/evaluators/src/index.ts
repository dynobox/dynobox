import type {IrAssertion, ShellToolMatcher, ToolKind} from '@dynobox/sdk';

import {
  describeShellMatcher,
  shellCommandMatches,
  validateRegexMatcher,
} from './shell-matcher.js';

export type ToolEvent = {
  kind: ToolKind;
  rawName: string;
  input: unknown;
  command?: string;
  status?: 'success' | 'failure';
  startedAt?: string;
  completedAt?: string;
};

export type EvaluationInput = {
  assertions: readonly IrAssertion[];
  toolEvents: readonly ToolEvent[];
};

export type AssertionResult = {
  assertionId: string;
  kind: string;
  passed: boolean;
  message: string;
  evidence?: unknown;
};

type AssertionLike = {
  id?: unknown;
  kind?: unknown;
};

export function evaluateAssertions(input: EvaluationInput): AssertionResult[] {
  return input.assertions.map((assertion) =>
    evaluateAssertion(assertion, input.toolEvents),
  );
}

function evaluateAssertion(
  assertion: IrAssertion,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  if (assertion.kind !== 'tool.called') {
    return unsupportedAssertionResult(assertion);
  }

  if (assertion.matcher !== undefined) {
    return evaluateShellMatcher(assertion, assertion.matcher, toolEvents);
  }

  const matchingEvent = toolEvents.find(
    (event) => event.kind === assertion.toolKind,
  );
  if (matchingEvent !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed tool "${assertion.toolKind}".`,
      evidence: matchingEvent,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message: `Expected tool "${assertion.toolKind}" to be called, but observed none.`,
  };
}

function evaluateShellMatcher(
  assertion: Extract<IrAssertion, {kind: 'tool.called'}>,
  matcher: ShellToolMatcher,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const shellEvents = toolEvents.filter((event) => event.kind === 'shell');
  const matcherDescription = describeShellMatcher(matcher);

  for (const event of shellEvents) {
    if (typeof event.command !== 'string') {
      continue;
    }

    const match = shellCommandMatches(event.command, matcher);
    if (match.error !== undefined) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: false,
        message: match.error,
      };
    }

    if (match.passed) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: true,
        message: `Observed shell command matching ${matcherDescription}.`,
        evidence: event,
      };
    }
  }

  const invalidRegex = validateRegexMatcher(matcher);
  if (invalidRegex !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: invalidRegex,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message: `Expected shell command matching ${matcherDescription}, but no matching shell command was observed.`,
  };
}

function unsupportedAssertionResult(assertion: AssertionLike): AssertionResult {
  const assertionId =
    typeof assertion.id === 'string' ? assertion.id : 'unknown';
  const kind = typeof assertion.kind === 'string' ? assertion.kind : 'unknown';

  return {
    assertionId,
    kind,
    passed: false,
    message: `Assertion kind "${kind}" is not supported by this evaluator.`,
  };
}
