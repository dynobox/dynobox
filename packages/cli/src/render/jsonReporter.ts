/**
 * Machine-readable run output. The reporter emits newline-delimited JSON:
 * one record per completed job followed by a final summary record.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {buildRunMatrix} from '../jobs.js';
import type {DebugLogPaths} from '../util/transcript.js';

const REPORT_SCHEMA = 'dynobox.report.v2';

export type RenderJsonRunOutputInput = {
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  configErrorCount?: number;
  debugLogPaths?: Map<string, DebugLogPaths>;
};

export function renderJsonRunOutput(input: RenderJsonRunOutputInput): string {
  const records = [
    ...input.results.map((result) => {
      const job = input.jobs.find((candidate) => candidate.id === result.jobId);
      return jobRecord(result, job, input.debugLogPaths?.get(result.jobId));
    }),
    summaryRecord(input),
  ];

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function jobRecord(
  result: LocalRunnerResult,
  job: LocalRunnerJob | undefined,
  debugLogPaths: DebugLogPaths | undefined,
) {
  return {
    schema: REPORT_SCHEMA,
    type: 'job',
    jobId: result.jobId,
    scenario: {
      id: result.scenarioId,
      name: job?.scenario.name ?? result.scenarioId,
    },
    harness: {
      id: result.harness,
      ...(result.model === undefined ? {} : {model: result.model}),
      ...(result.permissionMode === undefined
        ? {}
        : {permissionMode: result.permissionMode}),
    },
    iteration: result.iteration + 1,
    status: result.status,
    passed: result.passed,
    timing: result.timing,
    diagnostics: result.diagnostics,
    warnings: result.warnings,
    artifacts: result.artifacts,
    ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
    setup: {
      success: result.setupResult.success,
      commands: result.setupResult.logs.map((log) => ({
        command: log.command,
        exitCode: log.exitCode,
        durationMs: log.durationMs,
      })),
    },
    harnessOutput:
      result.harnessOutput === undefined
        ? undefined
        : {
            exitCode: result.harnessOutput.exitCode,
            durationMs: result.harnessOutput.durationMs,
          },
    observations: {
      toolEventCount: result.harnessResult?.toolEvents.length ?? 0,
      httpEventCount: result.httpEvents.length,
    },
    assertions: result.assertionResults.map((assertion) => {
      const label = jobAssertionLabel(job, assertion.assertionId);
      return {
        assertionId: assertion.assertionId,
        ...(label === undefined ? {} : {label}),
        type: assertion.type,
        passed: assertion.passed,
        message: assertion.message,
      };
    }),
  };
}

function jobAssertionLabel(
  job: LocalRunnerJob | undefined,
  assertionId: string,
): string | undefined {
  return job?.scenario.assertions.find(
    (assertion) => assertion.id === assertionId,
  )?.label;
}

function summaryRecord(input: RenderJsonRunOutputInput) {
  const passedCount = input.results.filter((result) => result.passed).length;
  const failedCount = input.results.length - passedCount;
  const configErrorCount = input.configErrorCount ?? 0;
  const totalMs = input.results.reduce(
    (sum, result) => sum + result.timing.totalMs,
    0,
  );
  const matrix = buildRunMatrix(input.jobs, input.results);

  return {
    schema: REPORT_SCHEMA,
    type: 'summary',
    status: failedCount === 0 && configErrorCount === 0 ? 'passed' : 'failed',
    totals: {
      jobs: input.results.length,
      passed: passedCount,
      failed: failedCount,
      configErrors: configErrorCount,
      warnings: input.results.reduce(
        (sum, result) => sum + result.warnings.length,
        0,
      ),
      durationMs: totalMs,
    },
    plan: {
      scenarios: matrix.scenarios.length,
      harnesses: matrix.harnesses.length,
      iterations: matrix.iterations.length,
    },
    matrix: {
      scenarios: matrix.scenarios,
      harnesses: matrix.harnesses,
      iterations: matrix.iterations,
      cells: matrix.cells.map((cell) => ({
        scenarioId: cell.scenarioId,
        scenarioName: cell.scenarioName,
        harness: cell.harness,
        passed: cell.passed,
        failed: cell.failed,
        total: cell.total,
        failedJobs: cell.failedJobs,
      })),
    },
    failedJobs: input.results
      .filter((result) => !result.passed)
      .map((result) => result.jobId),
    warningJobs: input.results
      .filter((result) => result.warnings.length > 0)
      .map((result) => result.jobId),
  };
}
