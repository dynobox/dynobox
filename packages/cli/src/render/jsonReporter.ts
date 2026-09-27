/**
 * Machine-readable run output. The reporter emits newline-delimited JSON:
 * one record per completed job followed by a final summary record.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {buildRunMatrix} from '../jobs.js';
import {
  anyOfBranchResults,
  anyOfMatchedBranch,
} from '../util/assertionBranch.js';
import type {DebugLogPaths} from '../util/transcript.js';

const REPORT_SCHEMA = 'dynobox.report.v2';

export type RenderJsonRunOutputInput = {
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  elapsedMs?: number;
  configErrorCount?: number;
  debugLogPaths?: Map<LocalRunnerJob, DebugLogPaths>;
};

export function renderJsonRunOutput(input: RenderJsonRunOutputInput): string {
  const schema = reportSchema(input);
  const records = [
    ...input.results.map((result, index) => {
      const job = input.jobs[index];
      return jobRecord(
        result,
        job,
        job === undefined ? undefined : input.debugLogPaths?.get(job),
        schema,
      );
    }),
    summaryRecord(input),
  ];

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function jobRecord(
  result: LocalRunnerResult,
  job: LocalRunnerJob | undefined,
  debugLogPaths: DebugLogPaths | undefined,
  schema: string,
) {
  return {
    schema,
    type: 'job',
    jobId: result.jobId,
    scenario: {
      id: result.scenarioId,
      name: job?.scenario.name ?? result.scenarioId,
    },
    harness: {
      id: result.harness,
      ...(result.model === undefined ? {} : {model: result.model}),
      version: result.harnessVersion ?? null,
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
      cliMockCallCount: result.cliMockCalls.length,
      harnessCliMockCallCount: result.harnessCliMockCallCount,
    },
    ...(result.mcp === undefined
      ? {}
      : {
          mcp: {
            ready: result.mcp.ready,
            finalized: result.mcp.finalized,
            failures: [...result.mcp.failures],
            callCount: result.mcp.calls.length,
            calls: result.mcp.calls.map(
              ({sequence, server, tool, category}) => ({
                sequence,
                server,
                tool,
                category,
              }),
            ),
          },
        }),
    assertions: result.assertionResults.map((assertion) => {
      const label = jobAssertionLabel(job, assertion.assertionId);
      const matchedBranchIndex = assertion.passed
        ? anyOfMatchedBranch(assertion.evidence)
        : undefined;
      const mcp = mcpEvidence(assertion.evidence);
      return {
        assertionId: assertion.assertionId,
        ...(label === undefined ? {} : {label}),
        type: assertion.type,
        passed: assertion.passed,
        message: assertion.message,
        ...(mcp === undefined ? {} : {mcp}),
        ...(schema === REPORT_SCHEMA || assertion.type !== 'anyOf'
          ? {}
          : {
              mcpBranches: anyOfBranchResults(assertion.evidence)?.flatMap(
                (branch, index) => {
                  const evidence = mcpEvidence(branch.evidence);
                  return evidence === undefined
                    ? []
                    : [
                        {
                          branchIndex: index + 1,
                          passed: branch.passed,
                          ...evidence,
                        },
                      ];
                },
              ),
            }),
        ...(matchedBranchIndex === undefined ? {} : {matchedBranchIndex}),
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
    schema: reportSchema(input),
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
      ...(input.elapsedMs === undefined ? {} : {elapsedMs: input.elapsedMs}),
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

function reportSchema(input: RenderJsonRunOutputInput): string {
  return input.jobs.some((job) => job.scenario.mcpMocks !== undefined) ||
    input.results.some((result) => result.mcp !== undefined)
    ? 'dynobox.report.v3'
    : REPORT_SCHEMA;
}

function mcpEvidence(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'mcp'
  )
    return undefined;
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.server !== 'string' ||
    typeof evidence.tool !== 'string' ||
    typeof evidence.hasInput !== 'boolean' ||
    typeof evidence.callCount !== 'number' ||
    typeof evidence.matchCount !== 'number'
  )
    return undefined;
  return {
    server: evidence.server,
    tool: evidence.tool,
    hasInput: evidence.hasInput,
    callCount: evidence.callCount,
    matchCount: evidence.matchCount,
    ...(evidence.failure === undefined
      ? {}
      : {failure: 'observation_unavailable'}),
  };
}
