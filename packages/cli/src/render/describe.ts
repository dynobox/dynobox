/**
 * Pure describe-functions: turn IR assertions, expectations, and tool events
 * into one-line human-readable strings. No styling, no layout — just text.
 */

import {
  describeCommandMatcher as describeCommandMatcherText,
  describeShellCommandMatcher,
} from '@dynobox/evaluators';
import type {ShellToolEvent, ToolEvent} from '@dynobox/runner-local';
import type {ShellCommandMatcher} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {truncate} from '../terminal/index.js';
import {assertionBranchWithId} from '../util/assertionBranch.js';

const SHELL_PREVIEW_MAX = 42;

/**
 * Compact, parenthesized rendering of an assertion.
 *
 * Examples: `tool.called(shell)`, `tool.called(shell, includes: pnpm test)`,
 * `sequence.inOrder(2 steps)`, `artifact.exists(README.md)`.
 */
export function describeAssertion(assertion: IrAssertion): string {
  if (assertion.kind === 'tool.called') {
    if (assertion.matcher !== undefined) {
      return `tool.called(${assertion.toolKind}, ${describeShellMatcher(assertion.matcher)})`;
    }
    if (assertion.pathMatcher !== undefined) {
      return `tool.called(${assertion.toolKind}, path: ${assertion.pathMatcher.path})`;
    }
    return `tool.called(${assertion.toolKind})`;
  }

  if (assertion.kind === 'tool.notCalled') {
    if (assertion.matcher !== undefined) {
      return `tool.notCalled(${assertion.toolKind}, ${describeShellMatcher(assertion.matcher)})`;
    }
    if (assertion.pathMatcher !== undefined) {
      return `tool.notCalled(${assertion.toolKind}, path: ${assertion.pathMatcher.path})`;
    }
    return `tool.notCalled(${assertion.toolKind})`;
  }

  if (assertion.kind === 'command.called') {
    return assertion.matcher === undefined
      ? `command.called(${assertion.executable})`
      : `command.called(${assertion.executable}, ${describeCommandMatcher(assertion.matcher)})`;
  }

  if (assertion.kind === 'command.notCalled') {
    return assertion.matcher === undefined
      ? `command.notCalled(${assertion.executable})`
      : `command.notCalled(${assertion.executable}, ${describeCommandMatcher(assertion.matcher)})`;
  }

  if (assertion.kind === 'verify.command') {
    return `verify.command(${assertion.command})`;
  }

  if (assertion.kind === 'sequence.inOrder') {
    return `sequence.inOrder(${assertion.steps.length} steps)`;
  }

  if (assertion.kind === 'anyOf') {
    return `anyOf(${assertion.steps.length} branches)`;
  }

  if (assertion.kind === 'skill.referenced') {
    return `skill.referenced(${assertion.skill})`;
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
    if (assertion.matcher !== undefined) {
      return `no ${describeShellMatcherExpectation(assertion.matcher)}`;
    }
    if (assertion.pathMatcher !== undefined) {
      return `no ${assertion.toolKind} tool call for path "${assertion.pathMatcher.path}"`;
    }
    return `no ${assertion.toolKind} tool call`;
  }

  if (assertion.kind === 'sequence.inOrder') {
    return assertion.steps.map(describeToolStepExpectation).join(' before ');
  }

  if (assertion.kind === 'anyOf') {
    return assertion.steps.map(describeAssertionNodeExpectation).join(' or ');
  }

  if (assertion.kind === 'command.notCalled') {
    return assertion.matcher === undefined
      ? `no ${assertion.executable} command`
      : `no ${assertion.executable} command with ${describeCommandMatcher(assertion.matcher)}`;
  }

  if (assertion.kind === 'skill.referenced') {
    return `skill "${assertion.skill}" instruction file reference`;
  }

  if (assertion.kind === 'verify.command') {
    const checks: string[] = [];
    if (assertion.exitCode !== undefined) {
      checks.push(`exit code ${assertion.exitCode}`);
    }
    if (assertion.stdout !== undefined) {
      checks.push(`stdout ${describeShellMatcher(assertion.stdout)}`);
    }
    if (assertion.stderr !== undefined) {
      checks.push(`stderr ${describeShellMatcher(assertion.stderr)}`);
    }
    return `verification command "${assertion.command}" with ${checks.join(', ')}`;
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
  if (assertion.pathMatcher !== undefined) {
    return `${assertion.toolKind} tool call for path "${assertion.pathMatcher.path}"`;
  }
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

/** Evidence shape for a normalized observed command segment. */
export type ObservedCommandEvidence = {executable: string; argv: string[]};

export function isObservedCommand(
  value: unknown,
): value is ObservedCommandEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'executable' in value &&
    typeof value.executable === 'string' &&
    'argv' in value &&
    Array.isArray(value.argv)
  );
}

function describeToolStepExpectation(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.kind === 'command.called') {
    return step.matcher === undefined
      ? `${step.executable} command`
      : `${step.executable} command with ${describeCommandMatcher(step.matcher)}`;
  }
  if (step.pathMatcher !== undefined) {
    return `${step.toolKind} tool call for path "${step.pathMatcher.path}"`;
  }
  if (step.matcher === undefined) return `${step.toolKind} tool call`;
  return describeShellMatcherExpectation(step.matcher);
}

function describeAssertionNodeExpectation(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>['steps'][number],
): string {
  return describeExpectation(assertionBranchWithId(assertion));
}

function describeShellMatcherExpectation(matcher: ShellCommandMatcher): string {
  return describeShellCommandMatcher(matcher, {style: 'expectation'});
}

function describeShellMatcher(matcher: ShellCommandMatcher): string {
  return describeShellCommandMatcher(matcher, {style: 'compact'});
}

function describeCommandMatcher(
  matcher: NonNullable<
    Extract<IrAssertion, {kind: 'command.called'}>['matcher']
  >,
): string {
  return describeCommandMatcherText(matcher, {style: 'compact'});
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
