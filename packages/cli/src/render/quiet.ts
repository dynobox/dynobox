/**
 * Quiet/CI-friendly run output: a one-line plan, a `.`/`F` mark per job, and
 * a compact failure list. Designed for log capture, not interactive viewing.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {assertionByIdForJobs, buildRunMatrix} from '../jobs.js';
import {
  colorStatus,
  formatDuration,
  type RenderContext,
} from '../terminal/index.js';
import {describeAssertion} from './describe.js';
import {formatJobHarness, renderPlanFromMatrix} from './plan.js';

export function renderQuietRun(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext,
): string {
  const matrix = buildRunMatrix(jobs, results);
  const assertionById = assertionByIdForJobs(jobs);
  const marks = results.map((result) => (result.passed ? '.' : 'F')).join('');
  const lines = [
    `  dynobox  ${renderPlanFromMatrix(matrix)}\n\n`,
    `  ${marks}\n`,
  ];

  const failed = results
    .map((result, index) => ({result, job: jobs[index]}))
    .filter(
      (entry): entry is {result: LocalRunnerResult; job: LocalRunnerJob} =>
        Boolean(entry.job && !entry.result.passed),
    );
  if (failed.length > 0) {
    lines.push('\n');
    for (const {result, job} of failed) {
      lines.push(`  FAIL  ${job.scenario.name} [${formatJobHarness(job)}]\n`);
      for (const assertionResult of result.assertionResults.filter(
        (assertionResult) => !assertionResult.passed,
      )) {
        const assertion = assertionById.get(assertionResult.assertionId);
        lines.push(
          `        ${assertion === undefined ? assertionResult.kind : describeAssertion(assertion)}\n`,
        );
      }
    }
  }

  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalMs = results.reduce(
    (sum, result) => sum + result.timing.totalMs,
    0,
  );
  lines.push(
    `\n  ${passedCount} passed, ${failedCount} failed in ${formatDuration(totalMs)}\n`,
  );
  return ctx.color ? colorStatus(ctx, lines.join(''), 'plain') : lines.join('');
}
