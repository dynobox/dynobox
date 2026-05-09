/**
 * Pure data transforms over the compiled IR: turn scenarios into runnable
 * jobs, summarize a run as a matrix, and answer assertion lookups.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import type {HarnessId} from '@dynobox/sdk';
import type {Ir, IrAssertion, IrHarnessConfig} from '@dynobox/sdk/ir';

import {unique} from './util/unique.js';

type RunMatrixHarness = {
  id: string;
  model?: string;
};

type RunMatrixCell = {
  scenarioId: string;
  scenarioName: string;
  harness: RunMatrixHarness;
  iteration: number;
  passed: boolean;
  failedAssertions: string[];
  durationMs: number;
};

export type RunMatrix = {
  scenarios: string[];
  harnesses: RunMatrixHarness[];
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
  const harnesses = uniqueHarnesses(jobs);
  const iterations = unique(jobs.map((job) => job.iteration + 1));
  const cells = jobs.flatMap((job, index): RunMatrixCell[] => {
    const result = results[index];
    if (result === undefined) return [];
    return [
      {
        scenarioId: job.scenario.id,
        scenarioName: job.scenario.name,
        harness: matrixHarness(job),
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

function uniqueHarnesses(jobs: readonly LocalRunnerJob[]): RunMatrixHarness[] {
  const byKey = new Map<string, RunMatrixHarness>();
  for (const job of jobs) {
    byKey.set(jobHarnessKey(job), matrixHarness(job));
  }
  return [...byKey.values()];
}

function matrixHarness(job: Pick<LocalRunnerJob, 'harness' | 'model'>) {
  return job.model === undefined
    ? {id: job.harness}
    : {id: job.harness, model: job.model};
}

function jobHarnessKey(job: Pick<LocalRunnerJob, 'harness' | 'model'>): string {
  return job.model === undefined ? job.harness : `${job.harness}/${job.model}`;
}
