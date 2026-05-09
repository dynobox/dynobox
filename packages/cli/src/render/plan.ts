import type {LocalRunnerJob} from '@dynobox/runner-local';

import {buildRunMatrix, type RunMatrix} from '../jobs.js';
import {formatCount} from '../terminal/index.js';

/** Render the compact plan summary used in run headers and quiet output. */
export function renderPlan(jobs: readonly LocalRunnerJob[]): string {
  return renderPlanFromMatrix(buildRunMatrix(jobs, []));
}

/** Render a precomputed run matrix as `N scenarios · M harnesses · K iterations`. */
export function renderPlanFromMatrix(
  matrix: Pick<RunMatrix, 'scenarios' | 'harnesses' | 'iterations'>,
): string {
  return `${formatCount(matrix.scenarios.length, 'scenario')} · ${formatCount(matrix.harnesses.length, 'harness')} · ${formatCount(matrix.iterations.length, 'iteration')}`;
}

/** Format a job's harness label, including model when configured. */
export function formatJobHarness(
  job: Pick<LocalRunnerJob, 'harness' | 'model'>,
): string {
  return job.model === undefined ? job.harness : `${job.harness}/${job.model}`;
}
