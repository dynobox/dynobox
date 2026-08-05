import type {AssertionResult, HttpEvent} from '@dynobox/evaluators';

import type {
  CliMockCall,
  LocalRunnerJob,
  LocalRunnerResult,
  LocalRunnerTiming,
  LocalRunnerWarning,
} from './runTypes.js';
import type {SetupResult} from './setup.js';

export function buildResult(
  job: LocalRunnerJob,
  result: Omit<
    LocalRunnerResult,
    | 'jobId'
    | 'scenarioId'
    | 'harness'
    | 'harnessVersion'
    | 'iteration'
    | 'passed'
    | 'httpEvents'
    | 'harnessCliMockCallCount'
    | 'cliMockCalls'
    | 'assertionResults'
    | 'verificationFailed'
    | 'diagnostics'
    | 'warnings'
    | 'timing'
  > & {
    harnessVersion?: string | null;
    assertionResults?: AssertionResult[];
    diagnostics?: string[];
    warnings?: LocalRunnerWarning[];
    httpEvents?: readonly HttpEvent[];
    harnessCliMockCallCount?: number;
    cliMockCalls?: readonly CliMockCall[];
    verificationFailed?: boolean;
    timing: LocalRunnerTiming;
  },
): LocalRunnerResult {
  const assertionResults = result.assertionResults ?? [];
  const diagnostics = result.diagnostics ?? [];
  const warnings = result.warnings ?? [];
  return {
    jobId: job.id,
    scenarioId: job.scenario.id,
    harness: job.harness,
    ...(job.model === undefined ? {} : {model: job.model}),
    harnessVersion: result.harnessVersion ?? null,
    ...(job.permissionMode === undefined
      ? {}
      : {permissionMode: job.permissionMode}),
    iteration: job.iteration,
    status: result.status,
    passed: result.status === 'passed',
    workDir: result.workDir,
    setupResult: result.setupResult,
    ...(result.harnessOutput === undefined
      ? {}
      : {harnessOutput: result.harnessOutput}),
    ...(result.harnessResult === undefined
      ? {}
      : {harnessResult: result.harnessResult}),
    httpEvents: result.httpEvents ?? [],
    harnessCliMockCallCount:
      result.harnessCliMockCallCount ?? result.cliMockCalls?.length ?? 0,
    cliMockCalls: result.cliMockCalls ?? [],
    artifacts: result.artifacts,
    assertionResults,
    verificationFailed: result.verificationFailed ?? false,
    diagnostics,
    warnings,
    timing: result.timing,
  };
}

export function setupDurationMs(setupResult: SetupResult): number {
  return setupResult.logs.reduce((total, log) => total + log.durationMs, 0);
}

export function buildTiming(input: {
  setupMs: number;
  harnessMs?: number;
  assertionsMs?: number;
}): LocalRunnerTiming {
  const harnessMs = input.harnessMs ?? 0;
  const assertionsMs = input.assertionsMs ?? 0;
  return {
    setupMs: input.setupMs,
    harnessMs,
    assertionsMs,
    totalMs: input.setupMs + harnessMs + assertionsMs,
  };
}
