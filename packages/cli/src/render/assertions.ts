/**
 * Per-assertion detail block, plus auxiliary observed-evidence lists shown
 * when relevant assertions fail (or in verbose/debug mode).
 */

import {
  type ArtifactInspection,
  extractObservedCommands,
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
  anyOfBranchResults,
  anyOfMatchedBranch,
  assertionBranchWithId,
} from '../util/assertionBranch.js';
import {
  assertionResultEvidence,
  formatHttpEvent,
  isHttpEvent,
  isToolEvent,
} from '../util/evidence.js';
import {
  formatVerifyCommandResult,
  isVerifyCommandResult,
} from '../util/verifyCommandResult.js';
import {
  describeAssertion,
  describeExpectation,
  isObservedCommand,
  isShellToolEvent,
  type ObservedCommandEvidence,
} from './describe.js';

type SequenceEvidence = ToolEvent | ObservedCommandEvidence;

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

  if (shouldShowObservedCommandSegments(result, assertionById, ctx)) {
    lines.push('\n        observed parsed commands during this run:\n');
    const commands = observedCommandSegments(
      result.harnessResult?.toolEvents ?? [],
    );
    if (commands.length === 0) {
      lines.push(`           ${dim(ctx, '(none)')}\n`);
    } else {
      for (const [index, command] of commands.entries()) {
        lines.push(
          `           ${index + 1}. ${dim(ctx, formatObservedCommand(command))}\n`,
        );
      }
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
    const observed = observedCommandArrayEvidence(result, assertion.id);
    if (observed === undefined || observed.length === 0) return fallback;
    return formatCommandCalledFailure(observed.length);
  }

  if (assertion.kind === 'command.notCalled') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    return isObservedCommand(evidence)
      ? `matching command: ${formatObservedCommand(evidence)}`
      : fallback;
  }

  if (assertion.kind === 'sequence.inOrder') {
    const matched = sequenceEvidence(result, assertion.id);
    if (matched === undefined) return fallback;
    const last = matched.at(-1);
    const suffix =
      last === undefined
        ? ''
        : `; last matched ${formatSequenceEvidence(last)}`;
    return `matched ${matched.length} of ${assertion.steps.length} ordered steps${suffix}`;
  }

  if (assertion.kind === 'anyOf') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    const matchedBranch = anyOfMatchedBranch(evidence);
    if (matchedBranch !== undefined) return `matched branch #${matchedBranch}`;
    const branchResults = anyOfBranchResults(evidence);
    if (branchResults !== undefined) {
      return formatAnyOfFailure(branchResults);
    }
  }

  if (assertion.kind === 'skill.referenced') {
    return `no matching SKILL.md reference observed`;
  }

  if (assertion.kind === 'verify.command') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    return isVerifyCommandResult(evidence)
      ? formatVerifyCommandResult(evidence, formatTextExcerpt)
      : fallback;
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
    const artifact =
      artifactInspectionEvidence(result, assertion.id) ??
      inspectArtifact(assertion.path, result.workDir);
    return formatArtifactExists(artifact);
  }

  if (assertion.kind === 'artifact.contains') {
    const artifact =
      artifactInspectionEvidence(result, assertion.id) ??
      inspectArtifact(assertion.path, result.workDir);
    return formatArtifactContains(artifact);
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

function formatCommandCalledFailure(observedCount: number): string {
  return `0/${observedCount} observed command segments matched`;
}

function formatAnyOfFailure(
  branchResults: readonly {message: string}[],
): string {
  const summaries = branchResults.map((branch, index) => {
    const detail = formatTextExcerpt(branch.message, 72);
    return `#${index + 1} ${detail}`;
  });
  return `0/${branchResults.length} branches matched (${summaries.join('; ')})`;
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

function artifactInspectionEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): ArtifactInspection | undefined {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  return isArtifactInspection(evidence) ? evidence : undefined;
}

function formatArtifactExists(artifact: ArtifactInspection): string {
  if (artifact.kind === 'exists') return `artifact exists at ${artifact.path}`;
  if (artifact.kind === 'missing')
    return `artifact missing at ${artifact.path}`;
  return artifact.message;
}

function formatArtifactContains(artifact: ArtifactInspection): string {
  if (artifact.kind === 'exists') {
    return artifact.contents === undefined
      ? `artifact exists at ${artifact.path}, but could not be read as UTF-8`
      : `artifact: ${formatTextExcerpt(artifact.contents)}`;
  }
  if (artifact.kind === 'missing')
    return `artifact missing at ${artifact.path}`;
  return artifact.message;
}

function isArtifactInspection(value: unknown): value is ArtifactInspection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ArtifactInspection>;
  if (candidate.kind === 'exists' || candidate.kind === 'missing') {
    return typeof candidate.path === 'string';
  }
  return candidate.kind === 'invalid' && typeof candidate.message === 'string';
}

function toolEventEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): ToolEvent | undefined {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  return isToolEvent(evidence) ? evidence : undefined;
}

function sequenceEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): SequenceEvidence[] | undefined {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  return Array.isArray(evidence) && evidence.every(isSequenceEvidence)
    ? evidence
    : undefined;
}

function observedCommandArrayEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): ObservedCommandEvidence[] | undefined {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  return Array.isArray(evidence) && evidence.every(isObservedCommand)
    ? evidence
    : undefined;
}

function httpEventEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): HttpEvent | undefined {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  return isHttpEvent(evidence) ? evidence : undefined;
}

function isSequenceEvidence(value: unknown): value is SequenceEvidence {
  return isToolEvent(value) || isObservedCommand(value);
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

function formatSequenceEvidence(evidence: SequenceEvidence): string {
  return isToolEvent(evidence)
    ? formatToolEvent(evidence)
    : `command ${formatObservedCommand(evidence)}`;
}

function inputPreview(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    return formatTextExcerpt(JSON.stringify(input), 100);
  } catch {
    return undefined;
  }
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

function shouldShowObservedCommandSegments(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): boolean {
  if (ctx.mode !== 'verbose' && ctx.mode !== 'debug') return false;
  if (![...assertionById.values()].some(assertionMentionsCommand)) return false;
  return (
    observedCommandSegments(result.harnessResult?.toolEvents ?? []).length > 0
  );
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
    (assertion.kind === 'sequence.inOrder' &&
      assertion.steps.some(sequenceStepMentionsShell)) ||
    (assertion.kind === 'anyOf' &&
      assertion.steps.some(assertionNodeMentionsShell))
  );
}

function assertionMentionsCommand(assertion: IrAssertion): boolean {
  if (
    assertion.kind === 'command.called' ||
    assertion.kind === 'command.notCalled'
  ) {
    return true;
  }
  return (
    (assertion.kind === 'sequence.inOrder' &&
      assertion.steps.some(sequenceStepMentionsCommand)) ||
    (assertion.kind === 'anyOf' &&
      assertion.steps.some(assertionNodeMentionsCommand))
  );
}

function assertionNodeMentionsShell(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>['steps'][number],
): boolean {
  return assertionMentionsShell(assertionBranchWithId(assertion));
}

function assertionNodeMentionsCommand(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>['steps'][number],
): boolean {
  return assertionMentionsCommand(assertionBranchWithId(assertion));
}

function sequenceStepMentionsShell(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): boolean {
  return step.kind === 'tool.called' && step.toolKind === 'shell';
}

function sequenceStepMentionsCommand(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): boolean {
  return step.kind === 'command.called';
}

function observedShellCommands(toolEvents: readonly ToolEvent[]): string[] {
  return toolEvents.flatMap((event) =>
    isShellToolEvent(event) ? [event.command] : [],
  );
}

function observedCommandSegments(
  toolEvents: readonly ToolEvent[],
): ObservedCommandEvidence[] {
  return extractObservedCommands(toolEvents);
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
