import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';

import type {ToolKind} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  describeShellMatcher,
  shellCommandMatches,
  shellCommandMatchPosition,
  validateRegexMatcher,
} from './shellMatcher.js';

/** Canonical HTTP event shape consumed by HTTP assertion evaluators. */
export type HttpEvent = {
  endpointId: string | null;
  method: string;
  url: string;
  host: string;
  timestamp: string;
  status?: number;
};

/** Canonical tool event shape consumed by assertion evaluators. */
export type ToolEvent = {
  kind: ToolKind;
  rawName: string;
  input: unknown;
  command?: string;
  status?: 'success' | 'failure';
  message?: string;
  startedAt?: string;
  completedAt?: string;
};

/** Inputs available when evaluating one scenario's compiled assertions. */
export type EvaluationInput = {
  assertions: readonly IrAssertion[];
  toolEvents: readonly ToolEvent[];
  httpEvents?: readonly HttpEvent[] | undefined;
  workDir?: string | undefined;
  transcript?: string | undefined;
  finalMessage?: string | undefined;
};

/** Result for one compiled assertion. */
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

type ToolCalledAssertion = Extract<IrAssertion, {kind: 'tool.called'}>;
type ToolCalledStep = Omit<ToolCalledAssertion, 'id'>;
type SequenceCursor = {
  eventIndex: number;
  commandOffset: number;
};

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

  if (assertion.kind === 'skill.invoked') {
    return evaluateSkillInvoked(assertion, input.toolEvents);
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

function evaluateToolCalledAssertion(
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

function evaluateToolNotCalledAssertion(
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

function evaluateSequenceInOrder(
  assertion: Extract<IrAssertion, {kind: 'sequence.inOrder'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const matchedEvents: ToolEvent[] = [];
  let cursor: SequenceCursor = {eventIndex: 0, commandOffset: 0};

  for (const [stepIndex, step] of assertion.steps.entries()) {
    const match = findMatchingSequenceStep(step, toolEvents, cursor);
    if (match.error !== undefined) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: false,
        message: match.error,
      };
    }

    if (match.event === undefined || match.nextCursor === undefined) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: false,
        message: `Expected ordered step #${stepIndex + 1} (${describeToolStep(step)}) to match an observed tool event, but none was observed after the previous step.`,
        evidence: matchedEvents,
      };
    }

    matchedEvents.push(match.event);
    cursor = match.nextCursor;
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: true,
    message: `Observed ${assertion.steps.length} ordered tool steps.`,
    evidence: matchedEvents,
  };
}

function findMatchingSequenceStep(
  step: ToolCalledStep,
  toolEvents: readonly ToolEvent[],
  cursor: SequenceCursor,
): {event?: ToolEvent; nextCursor?: SequenceCursor; error?: string} {
  if (step.matcher !== undefined) {
    const invalidRegex = validateRegexMatcher(step.matcher);
    if (invalidRegex !== undefined) return {error: invalidRegex};
  }

  for (let index = cursor.eventIndex; index < toolEvents.length; index += 1) {
    const event = toolEvents[index]!;
    if (event.kind !== step.toolKind) continue;

    if (step.matcher === undefined) {
      return {
        event,
        nextCursor: {eventIndex: index + 1, commandOffset: 0},
      };
    }

    if (event.kind !== 'shell' || typeof event.command !== 'string') continue;

    const startAt = index === cursor.eventIndex ? cursor.commandOffset : 0;
    const match = shellCommandMatchPosition(
      event.command,
      step.matcher,
      startAt,
    );
    if (!match.passed) {
      if (match.error !== undefined) return {error: match.error};
      continue;
    }

    return {
      event,
      nextCursor: {eventIndex: index, commandOffset: match.end},
    };
  }

  return {};
}

type ToolNotCalledStep = Omit<
  Extract<IrAssertion, {kind: 'tool.notCalled'}>,
  'id'
>;

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
  if (assertion.matcher === undefined) return true;
  if (event.kind !== 'shell' || typeof event.command !== 'string') return false;
  return shellCommandMatches(event.command, assertion.matcher).passed;
}

function toolCalledPassMessage(assertion: ToolCalledStep): string {
  if (assertion.matcher === undefined) {
    return `Observed tool "${assertion.toolKind}".`;
  }
  return `Observed shell command matching ${describeShellMatcher(assertion.matcher)}.`;
}

function toolCalledFailMessage(assertion: ToolCalledStep): string {
  if (assertion.matcher === undefined) {
    return `Expected tool "${assertion.toolKind}" to be called, but observed none.`;
  }
  return `Expected shell command matching ${describeShellMatcher(assertion.matcher)}, but no matching shell command was observed.`;
}

function toolNotCalledPassMessage(assertion: ToolNotCalledStep): string {
  if (assertion.matcher === undefined) {
    return `Observed no tool "${assertion.toolKind}" calls.`;
  }
  return `Observed no shell command matching ${describeShellMatcher(assertion.matcher)}.`;
}

function toolNotCalledFailMessage(assertion: ToolNotCalledStep): string {
  if (assertion.matcher === undefined) {
    return `Expected tool "${assertion.toolKind}" not to be called, but observed a matching call.`;
  }
  return `Expected no shell command matching ${describeShellMatcher(assertion.matcher)}, but observed a matching command.`;
}

function describeToolStep(step: ToolCalledStep): string {
  if (step.matcher === undefined) return `tool.called(${step.toolKind})`;
  return `tool.called(${step.toolKind}, ${describeShellMatcher(step.matcher)})`;
}

function evaluateSkillInvoked(
  assertion: Extract<IrAssertion, {kind: 'skill.invoked'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const event = toolEvents.find((toolEvent) =>
    toolEventMentionsSkillFile(toolEvent, assertion.skill),
  );

  if (event !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed skill "${assertion.skill}" instruction file access.`,
      evidence: event,
    };
  }

  return failed(
    assertion,
    `Expected skill "${assertion.skill}" to be invoked, but no access to its SKILL.md was observed.`,
  );
}

function toolEventMentionsSkillFile(
  event: ToolEvent,
  skillName: string,
): boolean {
  return stringsFromUnknown(event).some((value) =>
    stringMentionsSkillFile(value, skillName),
  );
}

function stringMentionsSkillFile(value: string, skillName: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  const normalizedSkill = skillName.toLowerCase();
  return [
    `.agents/skills/${normalizedSkill}/skill.md`,
    `.claude/skills/${normalizedSkill}/skill.md`,
  ].some((path) => normalized.includes(path));
}

function stringsFromUnknown(value: unknown): string[] {
  const strings: string[] = [];
  const seen = new WeakSet<object>();

  function visit(current: unknown): void {
    if (typeof current === 'string') {
      strings.push(current);
      return;
    }

    if (typeof current !== 'object' || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    for (const entry of Object.values(current)) visit(entry);
  }

  visit(value);
  return strings;
}

function evaluateHttpCalled(
  assertion: Extract<IrAssertion, {kind: 'http.called'}>,
  httpEvents: readonly HttpEvent[],
): AssertionResult {
  const matches = httpEvents.filter(
    (event) => event.endpointId === assertion.endpointId,
  );

  if (matches.length === 0) {
    return failed(
      assertion,
      `Expected HTTP endpoint "${assertion.endpointId}" to be called, but observed none.`,
    );
  }

  if (assertion.status === undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed HTTP endpoint "${assertion.endpointId}".`,
      evidence: matches[0],
    };
  }

  const statusMatch = matches.find(
    (event) => event.status === assertion.status,
  );
  if (statusMatch !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed HTTP endpoint "${assertion.endpointId}" with status ${assertion.status}.`,
      evidence: statusMatch,
    };
  }

  const observedStatuses = [
    ...new Set(matches.map((event) => event.status ?? 'unknown')),
  ].join(', ');
  return failed(
    assertion,
    `Expected HTTP endpoint "${assertion.endpointId}" to return status ${assertion.status}, but observed ${observedStatuses}.`,
  );
}

function evaluateHttpNotCalled(
  assertion: Extract<IrAssertion, {kind: 'http.notCalled'}>,
  httpEvents: readonly HttpEvent[],
): AssertionResult {
  const match = httpEvents.find(
    (event) => event.endpointId === assertion.endpointId,
  );

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: `Expected HTTP endpoint "${assertion.endpointId}" not to be called, but observed a matching request.`,
      evidence: match,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: true,
    message: `Observed no calls to HTTP endpoint "${assertion.endpointId}".`,
  };
}

function evaluateArtifactExists(
  assertion: Extract<IrAssertion, {kind: 'artifact.exists'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failed(assertion, resolved.error);
  }

  if (existsSync(resolved.path)) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Artifact "${assertion.path}" exists.`,
      evidence: {path: resolved.path},
    };
  }

  return failed(assertion, `Expected artifact "${assertion.path}" to exist.`);
}

function evaluateArtifactContains(
  assertion: Extract<IrAssertion, {kind: 'artifact.contains'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failed(assertion, resolved.error);
  }

  try {
    const contents = readFileSync(resolved.path, 'utf8');
    if (contents.includes(assertion.text)) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: true,
        message: `Artifact "${assertion.path}" contains expected text.`,
        evidence: {path: resolved.path},
      };
    }

    return failed(
      assertion,
      `Expected artifact "${assertion.path}" to contain "${assertion.text}".`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(
      assertion,
      `Could not read artifact "${assertion.path}" as UTF-8: ${message}`,
    );
  }
}

function resolveArtifactPath(
  artifactPath: string,
  workDir: string | undefined,
): {path: string; error?: never} | {error: string; path?: never} {
  if (workDir === undefined) {
    return {error: 'Artifact assertions require a work directory.'};
  }

  if (isAbsolute(artifactPath)) {
    return {error: `Artifact path "${artifactPath}" must be relative.`};
  }

  const workDirPath = resolve(workDir);
  const resolvedPath = resolve(workDirPath, artifactPath);
  const relativePath = relative(workDirPath, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return {
      error: `Artifact path "${artifactPath}" must stay within the work directory.`,
    };
  }

  return {path: resolvedPath};
}

function evaluateTextContains(input: {
  assertionId: string;
  kind: string;
  label: string;
  actual: string | undefined;
  expected: string;
}): AssertionResult {
  if (input.actual === undefined) {
    return {
      assertionId: input.assertionId,
      kind: input.kind,
      passed: false,
      message: `Expected ${input.label} to contain "${input.expected}", but ${input.label} text is unavailable.`,
    };
  }

  if (input.actual.includes(input.expected)) {
    return {
      assertionId: input.assertionId,
      kind: input.kind,
      passed: true,
      message: `Observed ${input.label} containing expected text.`,
    };
  }

  return {
    assertionId: input.assertionId,
    kind: input.kind,
    passed: false,
    message: `Expected ${input.label} to contain "${input.expected}".`,
  };
}

function failed(assertion: IrAssertion, message: string): AssertionResult {
  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message,
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
