/**
 * The summary block printed at the end of every run: pass/fail totals,
 * total duration, and (when present) a list of failed scenarios.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {assertionByIdForJobs} from '../jobs.js';
import {
  colorStatus,
  createRenderContext,
  formatDuration,
  leftRight,
  type RenderContext,
  separator,
} from '../terminal/index.js';
import {describeAssertion} from './describe.js';
import {describeWarning} from './warnings.js';

export function renderRunSummary(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext = createRenderContext(),
): string {
  const assertionById = assertionByIdForJobs(jobs);
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const totalMs = results.reduce(
    (sum, result) => sum + result.timing.totalMs,
    0,
  );
  const summary = `${colorStatus(ctx, `${passedCount} passed`, passedCount === results.length ? 'pass' : 'plain')}   ${colorStatus(ctx, `${failedCount} failed`, failedCount === 0 ? 'plain' : 'fail')}`;
  const lines = [
    `
  ${separator(ctx)}
  ${leftRight(summary, formatDuration(totalMs), ctx.width)}
`,
  ];

  const failedResults = results.filter((result) => !result.passed);
  if (failedResults.length > 0) {
    lines.push('\n  failed scenarios:\n');
    for (const result of failedResults) {
      const job = jobs.find((candidate) => candidate.id === result.jobId);
      const failedAssertion = result.assertionResults.find(
        (assertionResult) => !assertionResult.passed,
      );
      const assertion =
        failedAssertion === undefined
          ? undefined
          : assertionById.get(failedAssertion.assertionId);
      const detail =
        assertion === undefined
          ? (failedAssertion?.kind ?? result.status)
          : describeAssertion(assertion);
      lines.push(
        `    ${job?.scenario.name ?? result.scenarioId}   ${detail}\n`,
      );
    }
  }

  const warningResults = results.filter((result) => result.warnings.length > 0);
  if (warningResults.length > 0) {
    lines.push('\n  permission warnings:\n');
    for (const result of warningResults) {
      const job = jobs.find((candidate) => candidate.id === result.jobId);
      lines.push(
        `    ${job?.scenario.name ?? result.scenarioId}   ${describeWarning(result.warnings[0]!)}\n`,
      );
    }
  }

  return lines.join('');
}
