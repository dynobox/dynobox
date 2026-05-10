/**
 * Pure describe-functions: turn IR assertions, expectations, and tool events
 * into one-line human-readable strings. No styling, no layout — just text.
 */

import type {ShellToolEvent, ToolEvent} from '@dynobox/runner-local';
import type {ShellToolMatcher} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {truncate} from '../terminal/index.js';

const SHELL_PREVIEW_MAX = 42;

/**
 * Compact, parenthesized rendering of an assertion.
 *
 * Examples: `tool.called(shell)`, `tool.called(shell, includes: pnpm test)`,
 * `sequence.inOrder(2 steps)`, `artifact.exists(README.md)`.
 */
export function describeAssertion(assertion: IrAssertion): string {
  if (assertion.kind === 'tool.called') {
    return assertion.matcher === undefined
      ? `tool.called(${assertion.toolKind})`
      : `tool.called(${assertion.toolKind}, ${describeShellMatcher(assertion.matcher)})`;
  }

  if (assertion.kind === 'tool.notCalled') {
    return assertion.matcher === undefined
      ? `tool.notCalled(${assertion.toolKind})`
      : `tool.notCalled(${assertion.toolKind}, ${describeShellMatcher(assertion.matcher)})`;
  }

  if (assertion.kind === 'sequence.inOrder') {
    return `sequence.inOrder(${assertion.steps.length} steps)`;
  }

  if (assertion.kind === 'skill.invoked') {
    return `skill.invoked(${assertion.skill})`;
  }

  if (assertion.kind === 'artifact.exists') {
    return `artifact.exists(${assertion.path})`;
  }

  if (assertion.kind === 'artifact.contains') {
    return `artifact.contains(${assertion.path})`;
  }

  if (assertion.kind === 'transcript.contains') {
    return 'transcript.contains';
  }

  if (assertion.kind === 'finalMessage.contains') {
    return 'finalMessage.contains';
  }

  if (assertion.kind === 'http.called') {
    return assertion.status === undefined
      ? `http.called(${assertion.endpointId})`
      : `http.called(${assertion.endpointId}, status: ${assertion.status})`;
  }

  return `http.notCalled(${assertion.endpointId})`;
}

/**
 * Render the user-facing expectation phrase for a failed assertion. Used in
 * `expected  …` lines.
 */
export function describeExpectation(assertion: IrAssertion): string {
  if (assertion.kind === 'tool.notCalled') {
    return assertion.matcher === undefined
      ? `no ${assertion.toolKind} tool call`
      : `no ${describeShellMatcherExpectation(assertion.matcher)}`;
  }

  if (assertion.kind === 'sequence.inOrder') {
    return assertion.steps.map(describeToolStepExpectation).join(' before ');
  }

  if (assertion.kind === 'skill.invoked') {
    return `skill "${assertion.skill}" instruction file access`;
  }

  if (assertion.kind === 'artifact.exists') {
    return `artifact "${assertion.path}" to exist`;
  }

  if (assertion.kind === 'artifact.contains') {
    return `artifact "${assertion.path}" containing "${assertion.text}"`;
  }

  if (assertion.kind === 'transcript.contains') {
    return `transcript containing "${assertion.text}"`;
  }

  if (assertion.kind === 'finalMessage.contains') {
    return `final message containing "${assertion.text}"`;
  }

  if (assertion.kind !== 'tool.called') return describeAssertion(assertion);
  if (assertion.matcher === undefined) return `${assertion.toolKind} tool call`;
  return describeShellMatcherExpectation(assertion.matcher);
}

/**
 * One-line rendering of a tool event for live progress/status rows.
 *
 * Shell commands include a truncated single-line preview of the command.
 */
export function describeToolEvent(event: ToolEvent): string {
  if (isShellToolEvent(event)) {
    return `${event.rawName}: ${truncate(toSingleLine(event.command), SHELL_PREVIEW_MAX)}`;
  }
  return event.rawName;
}

export function isShellToolEvent(event: ToolEvent): event is ShellToolEvent {
  return event.kind === 'shell';
}

function describeToolStepExpectation(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.matcher === undefined) return `${step.toolKind} tool call`;
  return describeShellMatcherExpectation(step.matcher);
}

function describeShellMatcherExpectation(matcher: ShellToolMatcher): string {
  if ('equals' in matcher) {
    return `shell command equal to "${matcher.equals}"`;
  }
  if ('includes' in matcher) {
    return `shell command including "${matcher.includes}"`;
  }
  if ('startsWith' in matcher) {
    return `shell command starting with "${matcher.startsWith}"`;
  }
  return `shell command matching /${matcher.matches}/`;
}

function describeShellMatcher(matcher: ShellToolMatcher): string {
  if ('equals' in matcher) return `equals: ${matcher.equals}`;
  if ('includes' in matcher) return `includes: ${matcher.includes}`;
  if ('startsWith' in matcher) return `startsWith: ${matcher.startsWith}`;
  return `matches: ${matcher.matches}`;
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
