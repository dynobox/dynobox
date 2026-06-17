/**
 * Per-assertion detail block, plus auxiliary observed-evidence lists shown
 * when relevant assertions fail (or in verbose/debug mode).
 */

import {
  extractSkillFiles,
  inspectArtifact,
  stringsFromUnknown,
} from '@dynobox/evaluators';
import type {
  HttpEvent,
  LocalRunnerResult,
  ToolEvent,
} from '@dynobox/runner-local';
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
        : describeAssertionLabel(assertion);
    lines.push(
      `        ${colorStatus(ctx, symbol(ctx, status), status)} ${label}\n`,
    );

    if (!assertionResult.passed && assertion !== undefined) {
      lines.push(`           expected  ${describeExpectation(assertion)}\n`);
      lines.push(
        `           observed  ${describeObservedFailure(
          assertion,
          result,
          assertionResult.message,
        )}\n`,
      );
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

function describeAssertionLabel(assertion: IrAssertion): string {
  const description = describeAssertion(assertion);
  return assertion.label === undefined
    ? description
    : `${assertion.label}  ${description}`;
}

function describeObservedFailure(
  assertion: IrAssertion,
  result: LocalRunnerResult,
  fallback: string,
): string {
  if (assertion.kind === 'tool.called') {
    const events = result.harnessResult?.toolEvents ?? [];
    const sameKind = events.filter(
      (event) => event.kind === assertion.toolKind,
    );
    if (sameKind.length === 0)
      return `no ${assertion.toolKind} tool calls observed`;
    if (assertion.matcher !== undefined) {
      return `${formatCount(sameKind.length, `${assertion.toolKind} tool call`)} observed, none matching`;
    }
    if (assertion.pathMatcher !== undefined) {
      return `${formatCount(sameKind.length, `${assertion.toolKind} tool call`)} observed, none for path "${assertion.pathMatcher.path}"`;
    }
    return fallback;
  }

  if (assertion.kind === 'tool.notCalled') {
    const evidence = toolEventEvidence(result, assertion.id);
    return evidence === undefined
      ? fallback
      : `matching ${formatToolEvent(evidence)}`;
  }

  if (assertion.kind === 'command.called') {
    return fallback;
  }

  if (assertion.kind === 'command.notCalled') {
    const evidence = assertionResultEvidence(result, assertion.id);
    return isObservedCommand(evidence)
      ? `matching command: ${formatObservedCommand(evidence)}`
      : fallback;
  }

  if (assertion.kind === 'sequence.inOrder') {
    const matched = toolEventArrayEvidence(result, assertion.id);
    if (matched === undefined) return fallback;
    const last = matched.at(-1);
    const suffix =
      last === undefined ? '' : `; last matched ${formatToolEvent(last)}`;
    return `matched ${matched.length} of ${assertion.steps.length} ordered steps${suffix}`;
  }

  if (assertion.kind === 'skill.referenced') {
    return `no matching SKILL.md reference observed`;
  }

  if (assertion.kind === 'http.called') {
    const matches = result.httpEvents.filter(
      (event) => event.endpointId === assertion.endpointId,
    );
    if (matches.length === 0) return 'no matching HTTP requests observed';
    if (assertion.status === undefined) return fallback;
    return `matching endpoint statuses: ${[
      ...new Set(matches.map((event) => event.status ?? 'unknown')),
    ].join(', ')}`;
  }

  if (assertion.kind === 'http.notCalled') {
    const evidence = httpEventEvidence(result, assertion.id);
    return evidence === undefined
      ? fallback
      : `matching request: ${formatHttpEvent(evidence)}`;
  }

  if (assertion.kind === 'artifact.exists') {
    const artifact = inspectArtifact(assertion.path, result.workDir);
    if (artifact.kind === 'exists')
      return `artifact exists at ${artifact.path}`;
    if (artifact.kind === 'missing')
      return `artifact missing at ${artifact.path}`;
    return artifact.message;
  }

  if (assertion.kind === 'artifact.contains') {
    const artifact = inspectArtifact(assertion.path, result.workDir);
    if (artifact.kind === 'exists') {
      return artifact.contents === undefined
        ? `artifact exists at ${artifact.path}, but could not be read as UTF-8`
        : `artifact: ${formatTextExcerpt(artifact.contents)}`;
    }
    if (artifact.kind === 'missing')
      return `artifact missing at ${artifact.path}`;
    return artifact.message;
  }

  if (assertion.kind === 'finalMessage.contains') {
    const finalMessage = result.harnessResult?.finalMessage;
    return finalMessage === undefined
      ? fallback
      : `final message: ${formatTextExcerpt(finalMessage)}`;
  }

  if (assertion.kind === 'transcript.contains') {
    const transcript = result.harnessResult?.transcript;
    return transcript === undefined
      ? fallback
      : `transcript: ${formatTextExcerpt(transcript)}`;
  }

  return fallback;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatTextExcerpt(text: string, maxLength = 160): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return '(empty)';
  const excerpt =
    compact.length > maxLength
      ? `${compact.slice(0, Math.max(0, maxLength - 3))}...`
      : compact;
  return `"${excerpt.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function toolEventEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): ToolEvent | undefined {
  const evidence = result.assertionResults.find(
    (candidate) => candidate.assertionId === assertionId,
  )?.evidence;
  return isToolEvent(evidence) ? evidence : undefined;
}

function toolEventArrayEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): ToolEvent[] | undefined {
  const evidence = result.assertionResults.find(
    (candidate) => candidate.assertionId === assertionId,
  )?.evidence;
  return Array.isArray(evidence) && evidence.every(isToolEvent)
    ? evidence
    : undefined;
}

function httpEventEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): HttpEvent | undefined {
  const evidence = result.assertionResults.find(
    (candidate) => candidate.assertionId === assertionId,
  )?.evidence;
  return isHttpEvent(evidence) ? evidence : undefined;
}

function assertionResultEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): unknown {
  return result.assertionResults.find(
    (candidate) => candidate.assertionId === assertionId,
  )?.evidence;
}

function isToolEvent(value: unknown): value is ToolEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'rawName' in value &&
    typeof value.rawName === 'string'
  );
}

function isHttpEvent(value: unknown): value is HttpEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

function isObservedCommand(
  value: unknown,
): value is {executable: string; argv: string[]} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'executable' in value &&
    typeof value.executable === 'string' &&
    'argv' in value &&
    Array.isArray(value.argv)
  );
}

function formatToolEvent(event: ToolEvent): string {
  if (isShellToolEvent(event))
    return `shell command ${formatTextExcerpt(event.command)}`;
  const input = inputPreview(event.input);
  return input === undefined
    ? `${event.rawName} tool call`
    : `${event.rawName} tool call ${input}`;
}

function formatObservedCommand(command: {
  executable: string;
  argv: readonly string[];
}): string {
  return formatTextExcerpt([command.executable, ...command.argv].join(' '));
}

function inputPreview(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return formatTextExcerpt(JSON.stringify(input), 100);
  } catch {
    return undefined;
  }
}

function formatHttpEvent(event: HttpEvent): string {
  const status = event.status === undefined ? '' : ` -> ${event.status}`;
  return `${event.method} ${event.url}${status}`;
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
    return assertion?.kind === 'skill.referenced';
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
    assertion.steps.some(
      (step) => step.kind === 'tool.called' && step.toolKind === 'shell',
    )
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
