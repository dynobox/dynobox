/**
 * Pure data transforms over the compiled IR: turn scenarios into runnable
 * jobs, summarize a run as a matrix, and answer assertion lookups.
 *
 * No rendering or I/O. Anything that returns user-facing strings here
 * (`renderPlan`, `renderPlanFromMatrix`, `formatJobHarness`) is a tiny pure
 * formatter — full rendering lives under `render/`.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import type {HarnessId, Ir, IrAssertion, IrHarnessConfig} from '@dynobox/sdk';

import {formatCount} from './terminal/index.js';
import {unique} from './util/unique.js';

type RunMatrixCell = {
  scenarioId: string;
  scenarioName: string;
  harness: string;
  iteration: number;
  passed: boolean;
  failedAssertions: string[];
  durationMs: number;
};

export type RunMatrix = {
  scenarios: string[];
  harnesses: string[];
  iterations: number[];
  cells: RunMatrixCell[];
};

/**
 * Expand an IR into the full set of `LocalRunnerJob`s — one per
 * `(scenario, harness)` pair (and any additional iterations encoded in IR;
 * today the iteration count is always 1).
 *
 * Pass `harnesses` to override the per-scenario harness list (the `--harness`
 * CLI flag's contract).
 */
export function buildLocalRunnerJobs(
  ir: Ir,
  options: {harnesses?: readonly HarnessId[]} = {},
): LocalRunnerJob[] {
  const overrides = overrideHarnessConfigs(options.harnesses);
  return ir.scenarios.flatMap((scenario) =>
    (overrides ?? scenario.harnesses).map((harness) => ({
      id: `${scenario.id}.${harnessJobSuffix(harness)}.iteration.0`,
      scenario,
      harness: harness.id,
      ...(harness.model === undefined ? {} : {model: harness.model}),
      iteration: 0,
    })),
  );
}

/**
 * Build a `(scenario × harness × iteration)` matrix for summary rendering.
 * Cells line up positionally with `jobs`; missing results yield no cell.
 */
export function buildRunMatrix(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
): RunMatrix {
  const scenarios = unique(jobs.map((job) => job.scenario.name));
  const harnesses = unique(jobs.map(formatJobHarness));
  const iterations = unique(jobs.map((job) => job.iteration + 1));
  const cells = jobs.flatMap((job, index): RunMatrixCell[] => {
    const result = results[index];
    if (result === undefined) return [];
    return [
      {
        scenarioId: job.scenario.id,
        scenarioName: job.scenario.name,
        harness: formatJobHarness(job),
        iteration: job.iteration + 1,
        passed: result.passed,
        failedAssertions: result.assertionResults
          .filter((assertionResult) => !assertionResult.passed)
          .map((assertionResult) => assertionResult.assertionId),
        durationMs: result.timing.totalMs,
      },
    ];
  });

  return {scenarios, harnesses, iterations, cells};
}

/**
 * Render the plan summary line ("N scenarios · M harnesses · K iterations").
 *
 * Tiny pure formatter; lives here because both run-output and quiet-mode
 * renderers consume it.
 */
export function renderPlan(jobs: readonly LocalRunnerJob[]): string {
  return renderPlanFromMatrix(buildRunMatrix(jobs, []));
}

export function renderPlanFromMatrix(
  matrix: Pick<RunMatrix, 'scenarios' | 'harnesses' | 'iterations'>,
): string {
  return `${formatCount(matrix.scenarios.length, 'scenario')} · ${formatCount(matrix.harnesses.length, 'harness')} · ${formatCount(matrix.iterations.length, 'iteration')}`;
}

/**
 * Format the harness display name for a job, including its optional model:
 * `claude-code` or `codex/gpt-5`.
 */
export function formatJobHarness(
  job: Pick<LocalRunnerJob, 'harness' | 'model'>,
): string {
  return job.model === undefined ? job.harness : `${job.harness}/${job.model}`;
}

/**
 * Index every assertion across every job by id. Used by renderers to map
 * a runner-emitted `assertionId` back to the originating IR assertion so we
 * can describe the expectation, not just the kind.
 *
 * Lives here (not in `render/`) because it's a pure data transform over
 * jobs; both the static and live render paths consume it.
 */
export function assertionByIdForJobs(
  jobs: readonly LocalRunnerJob[],
): Map<string, IrAssertion> {
  return new Map(
    jobs.flatMap((job) =>
      job.scenario.assertions.map((assertion) => [assertion.id, assertion]),
    ),
  );
}

function overrideHarnessConfigs(
  harnesses: readonly HarnessId[] | undefined,
): IrHarnessConfig[] | undefined {
  return harnesses?.map((id) => ({id}));
}

function harnessJobSuffix(harness: IrHarnessConfig): string {
  if (harness.model === undefined) return harness.id;
  return `${harness.id}.${harness.model.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
}
