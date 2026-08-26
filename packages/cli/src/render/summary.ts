/**
 * The summary line printed at the end of every run. Leads with job counts;
 * assertion detail is secondary and always labeled. Zero-count entries are
 * never rendered.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {
  colorStatus,
  createRenderContext,
  formatCount,
  formatDuration,
  type RenderContext,
  separator,
  symbol,
} from '../terminal/index.js';

export type RunSummaryTotals = {
  jobs: number;
  passedJobs: number;
  failedJobs: number;
  passedAssertions: number;
  failedAssertions: number;
  jobErrors: number;
  warnings: number;
  durationMs: number;
};

/** Aggregate job/assertion/warning totals from finalized results. */
export function summarizeRunResults(
  results: readonly LocalRunnerResult[],
): RunSummaryTotals {
  const passedJobs = results.filter((result) => result.passed).length;
  const assertionResults = results.flatMap((result) => result.assertionResults);
  const failedAssertions = assertionResults.filter(
    (assertionResult) => !assertionResult.passed,
  ).length;
  return {
    jobs: results.length,
    passedJobs,
    failedJobs: results.length - passedJobs,
    passedAssertions: assertionResults.length - failedAssertions,
    failedAssertions,
    jobErrors: results.filter(
      (result) =>
        result.status === 'setup_failed' || result.status === 'harness_failed',
    ).length,
    warnings: results.reduce((sum, result) => sum + result.warnings.length, 0),
    durationMs: results.reduce((sum, result) => sum + result.timing.totalMs, 0),
  };
}

/**
 * The ordered summary segments (without separator/indentation), shared by
 * the default and quiet summaries:
 *
 * 1. Job counts (passed count when all passed; failed fraction when any job
 *    failed).
 * 2. Labeled assertion detail, when meaningful.
 * 3. Job error count, if nonzero.
 * 4. Warning count, if nonzero.
 */
export function runSummarySegments(
  totals: RunSummaryTotals,
  ctx: RenderContext,
): string[] {
  const segments: string[] = [];
  if (totals.failedAssertions > 0) {
    segments.push(
      colorStatus(
        ctx,
        `${symbol(ctx, 'fail')} ${totals.failedJobs} of ${totals.jobs} jobs failed`,
        'fail',
      ),
    );
    segments.push(formatCount(totals.failedAssertions, 'failed assertion'));
  } else if (totals.failedJobs > 0) {
    segments.push(
      colorStatus(
        ctx,
        `${symbol(ctx, 'fail')} ${totals.failedJobs} of ${totals.jobs} jobs failed`,
        'fail',
      ),
    );
  } else {
    segments.push(
      colorStatus(
        ctx,
        `${symbol(ctx, 'pass')} ${formatCount(totals.passedJobs, 'job')} passed`,
        'pass',
      ),
    );
    segments.push(
      totals.passedAssertions === 0
        ? 'no assertions'
        : formatCount(totals.passedAssertions, 'assertion'),
    );
  }

  if (totals.jobErrors > 0) {
    segments.push(
      colorStatus(
        ctx,
        `${symbol(ctx, 'fail')} ${formatCount(totals.jobErrors, 'job error')}`,
        'fail',
      ),
    );
  }
  if (totals.warnings > 0) {
    segments.push(
      colorStatus(ctx, formatCount(totals.warnings, 'warning'), 'skip'),
    );
  }
  return segments;
}

export function renderRunSummary(
  results: readonly LocalRunnerResult[],
  ctx: RenderContext = createRenderContext(),
  elapsedMs?: number,
): string {
  const totals = summarizeRunResults(results);
  const segments = [
    ...runSummarySegments(totals, ctx),
    formatDuration(elapsedMs ?? totals.durationMs),
  ];
  return `
  ${separator(ctx)}
  ${segments.join(' · ')}
`;
}
