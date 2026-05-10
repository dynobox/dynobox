/**
 * Per-assertion detail block, plus auxiliary observed-evidence lists shown
 * when relevant assertions fail (or in verbose/debug mode).
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
 * `expected …` / `observed …` lines, and (when relevant) lists of shell
 * commands and skill instruction files the harness actually observed.
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

  if (shouldShowObservedSkillFiles(result, assertionById, ctx)) {
    lines.push('\n        observed skill files during this run:\n');
    const skillFiles = observedSkillFiles(
      result.harnessResult?.toolEvents ?? [],
    );
    if (skillFiles.length === 0) {
      lines.push(`           ${dim(ctx, '(none)')}\n`);
    } else {
      for (const [index, skillFile] of skillFiles.entries()) {
        lines.push(`           ${index + 1}. ${dim(ctx, skillFile)}\n`);
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

function shouldShowObservedSkillFiles(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): boolean {
  if (ctx.mode === 'verbose' || ctx.mode === 'debug') {
    return (
      observedSkillFiles(result.harnessResult?.toolEvents ?? []).length > 0
    );
  }

  return result.assertionResults.some((assertionResult) => {
    if (assertionResult.passed) return false;
    const assertion = assertionById.get(assertionResult.assertionId);
    return assertion?.kind === 'skill.invoked';
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

function observedSkillFiles(toolEvents: readonly ToolEvent[]): string[] {
  const files = new Set<string>();
  for (const event of toolEvents) {
    for (const value of stringsFromUnknown(event)) {
      for (const skillFile of extractSkillFiles(value)) {
        files.add(skillFile);
      }
    }
  }
  return [...files];
}

function extractSkillFiles(value: string): string[] {
  const normalized = value.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const files: string[] = [];

  for (const marker of ['.agents/skills/', '.claude/skills/']) {
    let markerIndex = lower.indexOf(marker);
    while (markerIndex !== -1) {
      const start = skillPathStart(normalized, markerIndex);
      const end = skillPathEnd(normalized, markerIndex + marker.length);
      const candidate = normalized.slice(start, end);
      if (
        /(^|\/)\.(agents|claude)\/skills\/[^/]+\/skill\.md$/i.test(candidate)
      ) {
        files.push(candidate);
      }
      markerIndex = lower.indexOf(marker, markerIndex + marker.length);
    }
  }

  return files;
}

function skillPathStart(value: string, markerIndex: number): number {
  let start = markerIndex;
  while (start > 0 && !isSkillPathBoundary(value[start - 1]!)) start -= 1;
  return start;
}

function skillPathEnd(value: string, startAt: number): number {
  let end = startAt;
  while (end < value.length && !isSkillPathBoundary(value[end]!)) end += 1;
  return end;
}

function isSkillPathBoundary(value: string): boolean {
  return /[\s"'`<>{}[\]();|&]/.test(value);
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
