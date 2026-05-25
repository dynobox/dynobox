/**
 * Pure data transforms over the compiled IR: turn scenarios into runnable
 * jobs, summarize a run as a matrix, and answer assertion lookups.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import type {HarnessId, PermissionMode} from '@dynobox/sdk';
import type {
  Ir,
  IrAssertion,
  IrHarnessConfig,
  IrScenario,
} from '@dynobox/sdk/ir';

import {unique} from './util/unique.js';

type RunMatrixHarness = {
  id: string;
  model?: string;
  permissionMode?: PermissionMode;
};

type RunMatrixCell = {
  scenarioId: string;
  scenarioName: string;
  harness: RunMatrixHarness;
  runs: Array<{
    iteration: number;
    passed: boolean;
    jobId: string;
  }>;
  total: number;
  passed: number;
  failed: number;
  failedAssertions: string[];
  failedJobs: string[];
  durationMs: number;
};

export type RunMatrix = {
  scenarios: Array<{id: string; name: string}>;
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
  options: {
    harnesses?: readonly HarnessId[];
    permissionMode?: PermissionMode;
    scenarioPatterns?: readonly string[];
    iterations?: number;
  } = {},
): LocalRunnerJob[] {
  const overrides = overrideHarnessConfigs(
    options.harnesses,
    options.permissionMode,
  );
  const iterations = options.iterations ?? 1;
  const scenarios = filterScenarios(ir.scenarios, options.scenarioPatterns);
  return scenarios.flatMap((scenario) =>
    (overrides ?? scenario.harnesses).flatMap((harness) => {
      return Array.from({length: iterations}, (_, iteration) => {
        const permissionMode = permissionModeForHarness(
          harness,
          options.permissionMode,
        );
        const jobHarness =
          permissionMode === harness.permissionMode
            ? harness
            : {
                ...harness,
                ...(permissionMode === undefined ? {} : {permissionMode}),
              };
        return {
          id: `${scenario.id}.${harnessJobSuffix(jobHarness)}.iteration.${iteration}`,
          scenario,
          harness: harness.id,
          ...(harness.model === undefined ? {} : {model: harness.model}),
          ...(permissionMode === undefined ? {} : {permissionMode}),
          iteration,
        };
      });
    }),
  );
}

function filterScenarios(
  scenarios: readonly IrScenario[],
  patterns: readonly string[] | undefined,
): readonly IrScenario[] {
  if (patterns === undefined || patterns.length === 0) return scenarios;
  return scenarios.filter((scenario) =>
    patterns.some((pattern) => scenarioMatchesPattern(scenario, pattern)),
  );
}

function scenarioMatchesPattern(
  scenario: IrScenario,
  pattern: string,
): boolean {
  const matcher = globPatternToRegExp(pattern);
  return (
    matcher.test(scenario.name) ||
    scenarioIdMatchCandidates(scenario.id).some((id) => matcher.test(id))
  );
}

function scenarioIdMatchCandidates(id: string): string[] {
  return unique([
    id,
    unprefixedScenarioId(id),
    unprefixedScenarioId(unprefixedSourceId(id)),
    unprefixedSourceId(id),
  ]);
}

function unprefixedScenarioId(id: string): string {
  return id.startsWith('scenario.') ? id.slice('scenario.'.length) : id;
}

function unprefixedSourceId(id: string): string {
  const marker = '::';
  const index = id.lastIndexOf(marker);
  return index === -1 ? id : id.slice(index + marker.length);
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += escapeRegExp(char);
    }
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

/**
 * Build a `(scenario × harness × iteration)` matrix for summary rendering.
 * Cells line up positionally with `jobs`; missing results yield no cell.
 */
export function buildRunMatrix(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
): RunMatrix {
  const scenarios = uniqueScenarios(jobs);
  const harnesses = uniqueHarnesses(jobs);
  const iterations = unique(jobs.map((job) => job.iteration + 1));
  const byKey = new Map<string, RunMatrixCell>();

  jobs.forEach((job, index) => {
    const result = results[index];
    if (result === undefined) return;
    const harness = matrixHarness(job);
    const key = `${job.scenario.id}\0${jobHarnessKey(job)}`;
    const existing = byKey.get(key);
    const failedAssertions = result.assertionResults
      .filter((assertionResult) => !assertionResult.passed)
      .map((assertionResult) => assertionResult.assertionId);
    if (existing === undefined) {
      byKey.set(key, {
        scenarioId: job.scenario.id,
        scenarioName: job.scenario.name,
        harness,
        runs: [
          {
            iteration: job.iteration + 1,
            passed: result.passed,
            jobId: result.jobId,
          },
        ],
        total: 1,
        passed: result.passed ? 1 : 0,
        failed: result.passed ? 0 : 1,
        failedAssertions,
        failedJobs: result.passed ? [] : [result.jobId],
        durationMs: result.timing.totalMs,
      });
      return;
    }

    existing.runs.push({
      iteration: job.iteration + 1,
      passed: result.passed,
      jobId: result.jobId,
    });
    existing.total += 1;
    existing.passed += result.passed ? 1 : 0;
    existing.failed += result.passed ? 0 : 1;
    existing.durationMs += result.timing.totalMs;
    existing.failedAssertions.push(...failedAssertions);
    if (!result.passed) existing.failedJobs.push(result.jobId);
  });

  return {scenarios, harnesses, iterations, cells: [...byKey.values()]};
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
  permissionMode: PermissionMode | undefined,
): IrHarnessConfig[] | undefined {
  return harnesses?.map((id) =>
    permissionMode === undefined ? {id} : {id, permissionMode},
  );
}

function harnessJobSuffix(harness: IrHarnessConfig): string {
  const parts: string[] = [harness.id];
  if (harness.model !== undefined) {
    parts.push(harness.model.replace(/[^a-zA-Z0-9._-]+/g, '-'));
  }
  if (harness.permissionMode !== undefined) {
    parts.push(harness.permissionMode);
  }
  return parts.join('.');
}

function uniqueHarnesses(jobs: readonly LocalRunnerJob[]): RunMatrixHarness[] {
  const byKey = new Map<string, RunMatrixHarness>();
  for (const job of jobs) {
    byKey.set(jobHarnessKey(job), matrixHarness(job));
  }
  return [...byKey.values()];
}

function uniqueScenarios(
  jobs: readonly Pick<LocalRunnerJob, 'scenario'>[],
): Array<{id: string; name: string}> {
  const byId = new Map<string, {id: string; name: string}>();
  for (const job of jobs) {
    byId.set(job.scenario.id, {
      id: job.scenario.id,
      name: job.scenario.name,
    });
  }
  return [...byId.values()];
}

function matrixHarness(
  job: Pick<LocalRunnerJob, 'harness' | 'model' | 'permissionMode'>,
): RunMatrixHarness {
  return {
    id: job.harness,
    ...(job.model === undefined ? {} : {model: job.model}),
    ...(job.permissionMode === undefined
      ? {}
      : {permissionMode: job.permissionMode}),
  };
}

function jobHarnessKey(
  job: Pick<LocalRunnerJob, 'harness' | 'model' | 'permissionMode'>,
): string {
  const parts: string[] = [job.harness];
  if (job.model !== undefined) parts.push(job.model);
  if (job.permissionMode !== undefined) parts.push(job.permissionMode);
  return parts.join('/');
}

function permissionModeForHarness(
  harness: IrHarnessConfig,
  override: PermissionMode | undefined,
): PermissionMode | undefined {
  return override ?? harness.permissionMode;
}
