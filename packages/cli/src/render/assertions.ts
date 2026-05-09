/**
 * Per-assertion detail block, plus the "observed shell commands" auxiliary
 * list shown when a shell-related assertion fails (or in verbose/debug mode).
 */

import type {LocalRunnerResult, ToolEvent} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  colorStatus,
  dim,
  type RenderContext,
  symbol,
} from '../terminal/index.js';
import {
  describeAssertion,
  describeExpectation,
  isShellToolEvent,
} from './describe.js';

/**
 * Render the per-assertion checklist for a job. Failed assertions also show
 * `expected …` / `observed …` lines, and (when relevant) a list of shell
 * commands the harness actually ran.
 */
export function renderAssertionDetails(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  if (result.assertionResults.length === 0) return '';

  const lines: string[] = [];
  for (const assertionResult of result.assertionResults) {
    const assertion = assertionById.get(assertionResult.assertionId);
    const status = assertionResult.passed ? 'pass' : 'fail';
    const label =
      assertion === undefined
        ? assertionResult.kind
        : describeAssertion(assertion);
    lines.push(
      `        ${colorStatus(ctx, symbol(ctx, status), status)} ${label}\n`,
    );

    if (!assertionResult.passed && assertion !== undefined) {
      lines.push(`           expected  ${describeExpectation(assertion)}\n`);
      lines.push(`           observed  ${assertionResult.message}\n`);
    }
  }

  if (shouldShowObservedShellCommands(result, assertionById, ctx)) {
    lines.push('\n        observed shell commands during this run:\n');
    const shellCommands = observedShellCommands(
      result.harnessResult?.toolEvents ?? [],
    );
    if (shellCommands.length === 0) {
      lines.push(`           ${dim(ctx, '(none)')}\n`);
    } else {
      for (const [index, command] of shellCommands.entries()) {
        lines.push(`           ${index + 1}. ${dim(ctx, command)}\n`);
      }
    }
  }

  return lines.join('');
}

function shouldShowObservedShellCommands(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): boolean {
  if (ctx.mode === 'verbose' || ctx.mode === 'debug') {
    return (
      observedShellCommands(result.harnessResult?.toolEvents ?? []).length > 0
    );
  }

  return result.assertionResults.some((assertionResult) => {
    if (assertionResult.passed) return false;
    const assertion = assertionById.get(assertionResult.assertionId);
    return assertionMentionsShell(assertion);
  });
}

function assertionMentionsShell(assertion: IrAssertion | undefined): boolean {
  if (assertion === undefined) return false;
  if (
    (assertion.kind === 'tool.called' || assertion.kind === 'tool.notCalled') &&
    assertion.toolKind === 'shell'
  ) {
    return true;
  }
  return (
    assertion.kind === 'sequence.inOrder' &&
    assertion.steps.some((step) => step.toolKind === 'shell')
  );
}

function observedShellCommands(toolEvents: readonly ToolEvent[]): string[] {
  return toolEvents.flatMap((event) =>
    isShellToolEvent(event) ? [event.command] : [],
  );
}
