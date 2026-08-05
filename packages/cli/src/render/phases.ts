/**
 * Phase rows ("setup", "harness", "assertions") and the three concrete
 * per-phase renderers used by job details. Used by both static and live
 * output paths.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {
  colorStatus,
  dim,
  formatCount,
  formatDuration,
  formatLiveDuration,
  leftRight,
  type RenderContext,
  symbol,
} from '../terminal/index.js';

const PHASE_LABEL_WIDTH = 11;

export type PhaseStatus = 'pass' | 'fail' | 'skip' | 'running';

export type PhaseRowInput = {
  status: PhaseStatus;
  label: string;
  detail: string;
  durationMs?: number;
  spinnerFrame?: string;
  /** Suppress the leading status icon (used for collapsed pass rows). */
  omitIcon?: boolean;
};

/**
 * Render a single phase row of the form:
 *
 *         ✓ setup      3 commands                               1.4s
 *
 * Indented to sit under a grouped scenario result row, aligned with the
 * per-assertion detail lines.
 */
export function renderPhaseRow(
  ctx: RenderContext,
  input: PhaseRowInput,
): string {
  const labelText = input.label.padEnd(PHASE_LABEL_WIDTH);
  const inner =
    input.omitIcon === true
      ? dim(ctx, `${labelText}${input.detail}`)
      : `${renderPhaseIcon(ctx, input)} ${labelText}${input.detail}`;
  const left = `      ${inner}`;
  const formatter =
    input.status === 'running' ? formatLiveDuration : formatDuration;
  const right =
    input.durationMs === undefined ? '' : dim(ctx, formatter(input.durationMs));
  return `  ${leftRight(left, right, ctx.width)}`;
}

/**
 * Setup phase row, sourced from a finalized result.
 */
export function renderSetupPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  const passed = result.setupResult.success;
  return `${renderPhaseRow(ctx, {
    status: passed ? 'pass' : 'fail',
    label: 'setup',
    detail: formatCount(result.setupResult.logs.length, 'command'),
    durationMs: result.timing.setupMs,
    omitIcon,
  })}\n`;
}

/**
 * Harness phase row. Skipped if setup failed; failed if harness errored.
 */
export function renderHarnessPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  if (result.status === 'setup_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'skip',
      label: 'harness',
      detail: 'skipped',
    })}\n`;
  }

  if (result.status === 'harness_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'fail',
      label: 'harness',
      detail: 'failed',
      durationMs: result.timing.harnessMs,
    })}\n`;
  }

  return `${renderPhaseRow(ctx, {
    status: 'pass',
    label: 'harness',
    detail: `ran prompt ${dim(ctx, formatToolCount(result))}`,
    durationMs: result.timing.harnessMs,
    omitIcon,
  })}\n`;
}

/**
 * Assertions phase row. Skipped if a prior phase failed.
 */
export function renderAssertionsPhase(
  result: LocalRunnerResult,
  ctx: RenderContext,
  omitIcon: boolean,
): string {
  if (result.status === 'setup_failed' || result.status === 'harness_failed') {
    return `${renderPhaseRow(ctx, {
      status: 'skip',
      label: 'assertions',
      detail: 'skipped',
    })}\n`;
  }

  const passedCount = result.assertionResults.filter(
    (assertionResult) => assertionResult.passed,
  ).length;
  const totalCount = result.assertionResults.length;
  const detail =
    totalCount === 0 && result.verificationFailed
      ? 'verification failed'
      : `${passedCount} of ${totalCount} passed${result.verificationFailed ? '; verification failed' : ''}`;
  return `${renderPhaseRow(ctx, {
    status:
      passedCount === totalCount && !result.verificationFailed
        ? 'pass'
        : 'fail',
    label: 'assertions',
    detail,
    durationMs: result.timing.assertionsMs,
    omitIcon,
  })}\n`;
}

/**
 * Sum the per-command setup durations into a total in ms.
 *
 * Lives here because it's used by `live/progress.ts` to derive a setup
 * duration when the runner reports `setup.completed`.
 */
export function setupDurationMs(
  setupResult: LocalRunnerResult['setupResult'],
): number {
  return setupResult.logs.reduce((total, log) => total + log.durationMs, 0);
}

function renderPhaseIcon(ctx: RenderContext, input: PhaseRowInput): string {
  const iconText =
    input.status === 'running' && input.spinnerFrame !== undefined
      ? input.spinnerFrame
      : symbol(ctx, input.status);
  return colorStatus(
    ctx,
    iconText,
    input.status === 'running' ? 'plain' : input.status,
  );
}

function formatToolCount(result: LocalRunnerResult): string {
  return formatCount(result.harnessResult?.toolEvents.length ?? 0, 'tool');
}
