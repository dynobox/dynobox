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
  if (assertion.type === 'tool.called') {
    if (assertion.command !== undefined) {
      return `tool.called(${assertion.tool}, ${describeShellMatcher(assertion.command)})`;
    }
    if (assertion.path !== undefined) {
      return `tool.called(${assertion.tool}, path: ${assertion.path})`;
    }
    return `tool.called(${assertion.tool})`;
  }

  if (assertion.type === 'tool.notCalled') {
    if (assertion.command !== undefined) {
      return `tool.notCalled(${assertion.tool}, ${describeShellMatcher(assertion.command)})`;
    }
    if (assertion.path !== undefined) {
      return `tool.notCalled(${assertion.tool}, path: ${assertion.path})`;
    }
    return `tool.notCalled(${assertion.tool})`;
  }

  if (assertion.type === 'command.called') {
    return assertion.command === undefined
      ? `command.called(${assertion.executable})`
      : `command.called(${assertion.executable}, ${describeCommandMatcher(assertion.command)})`;
  }

  if (assertion.type === 'command.notCalled') {
    return assertion.command === undefined
      ? `command.notCalled(${assertion.executable})`
      : `command.notCalled(${assertion.executable}, ${describeCommandMatcher(assertion.command)})`;
  }

  if (assertion.type === 'verify.command') {
    return `verify.command(${assertion.command})`;
  }

  if (assertion.type === 'sequence.inOrder') {
    return `sequence.inOrder(${assertion.steps.length} steps)`;
  }

  if (assertion.type === 'anyOf') {
    return `anyOf(${assertion.steps.length} branches)`;
  }

  if (assertion.type === 'skill.referenced') {
    return `skill.referenced(${assertion.skill})`;
  }

  if (assertion.type === 'artifact.exists') {
    return `artifact.exists(${assertion.path})`;
  }

  if (assertion.type === 'artifact.notExists') {
    return `artifact.notExists(${assertion.path})`;
  }

  if (assertion.type === 'artifact.contains') {
    return `artifact.contains(${assertion.path})`;
  }

  if (assertion.type === 'artifact.unchanged') {
    return `artifact.unchanged(${assertion.path})`;
  }

  if (assertion.type === 'transcript.contains') {
    return 'transcript.contains';
  }

  if (assertion.type === 'finalMessage.contains') {
    return 'finalMessage.contains';
  }

  if (assertion.type === 'http.called') {
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
  if (assertion.type === 'tool.notCalled') {
    if (assertion.command !== undefined) {
      return `no ${describeShellMatcherExpectation(assertion.command)}`;
    }
    if (assertion.path !== undefined) {
      return `no ${assertion.tool} tool call for path "${assertion.path}"`;
    }
    return `no ${assertion.tool} tool call`;
  }

  if (assertion.type === 'sequence.inOrder') {
    return assertion.steps.map(describeToolStepExpectation).join(' before ');
  }

  if (assertion.type === 'anyOf') {
    return assertion.steps.map(describeAssertionNodeExpectation).join(' or ');
  }

  if (assertion.type === 'command.notCalled') {
    return assertion.command === undefined
      ? `no ${assertion.executable} command`
      : `no ${assertion.executable} command with ${describeCommandMatcher(assertion.command)}`;
  }

  if (assertion.type === 'skill.referenced') {
    return `skill "${assertion.skill}" instruction file reference`;
  }

  if (assertion.type === 'verify.command') {
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

  if (assertion.type === 'artifact.exists') {
    return `artifact "${assertion.path}" to exist`;
  }

  if (assertion.type === 'artifact.notExists') {
    return `artifact "${assertion.path}" to be absent`;
  }

  if (assertion.type === 'artifact.contains') {
    return `artifact "${assertion.path}" containing "${assertion.text}"`;
  }

  if (assertion.type === 'artifact.unchanged') {
    return `artifact "${assertion.path}" unchanged from post-setup baseline`;
  }

  if (assertion.type === 'transcript.contains') {
    return `transcript containing "${assertion.text}"`;
  }

  if (assertion.type === 'finalMessage.contains') {
    return `final message containing "${assertion.text}"`;
  }

  if (assertion.type !== 'tool.called') return describeAssertion(assertion);
  if (assertion.path !== undefined) {
    return `${assertion.tool} tool call for path "${assertion.path}"`;
  }
  if (assertion.command === undefined) return `${assertion.tool} tool call`;
  return describeShellMatcherExpectation(assertion.command);
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
  step: Extract<IrAssertion, {type: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.type === 'command.called') {
    return step.command === undefined
      ? `${step.executable} command`
      : `${step.executable} command with ${describeCommandMatcher(step.command)}`;
  }
  if (step.path !== undefined) {
    return `${step.tool} tool call for path "${step.path}"`;
  }
  if (step.command === undefined) return `${step.tool} tool call`;
  return describeShellMatcherExpectation(step.command);
}

function describeAssertionNodeExpectation(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>['steps'][number],
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
    Extract<IrAssertion, {type: 'command.called'}>['command']
  >,
): string {
  return describeCommandMatcherText(matcher, {style: 'compact'});
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
