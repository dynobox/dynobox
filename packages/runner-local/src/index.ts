import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {evaluateAssertions, type AssertionResult} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk';

import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
} from './harnesses/index.js';
import {runScenarioSetup} from './setup.js';
import type {SetupResult} from './setup.js';

export type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
  ToolKind,
} from './harnesses/index.js';
export {FakeHarness, normalizeToolKind} from './harnesses/index.js';
export type {RunSetupOptions, SetupCommandLog, SetupResult} from './setup.js';
export {runScenarioSetup, runSetup} from './setup.js';

export type LocalRunnerJob = {
  id: string;
  scenario: IrScenario;
  iteration: number;
};

export type RunJobOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type LocalRunnerStatus =
  | 'passed'
  | 'setup_failed'
  | 'harness_failed'
  | 'assertion_failed';

export type LocalArtifact = {
  kind: 'work_dir';
  path: string;
};

export type LocalRunnerResult = {
  jobId: string;
  scenarioId: string;
  iteration: number;
  status: LocalRunnerStatus;
  passed: boolean;
  workDir: string;
  setupResult: SetupResult;
  harnessOutput?: HarnessRunOutput;
  harnessResult?: HarnessResult;
  artifacts: LocalArtifact[];
  assertionResults: AssertionResult[];
  diagnostics: string[];
};

export async function runJob(
  job: LocalRunnerJob,
  options: RunJobOptions = {},
): Promise<LocalRunnerResult> {
  const workDir = await createWorkDir(options.scratchRoot);
  const artifacts: LocalArtifact[] = [{kind: 'work_dir', path: workDir}];

  const setupOptions: Parameters<typeof runScenarioSetup>[0] = {
    scenario: job.scenario,
    workDir,
  };
  if (options.env !== undefined) setupOptions.env = options.env;

  const setupResult = await runScenarioSetup(setupOptions);
  if (!setupResult.success) {
    return buildResult(job, {
      status: 'setup_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [setupFailureDiagnostic(setupResult)],
    });
  }

  const harness = options.harnesses?.find(
    (candidate) => candidate.id === job.scenario.harness,
  );
  if (harness === undefined) {
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [
        `No harness registered for scenario harness "${job.scenario.harness}".`,
      ],
    });
  }

  let harnessOutput: HarnessRunOutput;
  try {
    const harnessInput = {
      prompt: job.scenario.prompt,
      workDir,
      env: options.env ?? {},
    };
    harnessOutput = await harness.run(
      options.timeoutMs === undefined
        ? harnessInput
        : {...harnessInput, timeoutMs: options.timeoutMs},
    );
  } catch (error) {
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [
        `Harness "${harness.id}" failed to run: ${errorMessage(error)}`,
      ],
    });
  }

  let harnessResult: HarnessResult;
  try {
    harnessResult = harness.extractResult(harnessOutput);
  } catch (error) {
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      harnessOutput,
      diagnostics: [
        `Harness "${harness.id}" failed to extract result: ${errorMessage(error)}`,
      ],
    });
  }

  if (harnessResult.exitCode !== 0) {
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      harnessOutput,
      harnessResult,
      diagnostics: [harnessExitDiagnostic(harnessResult, harnessOutput)],
    });
  }

  const assertionResults = evaluateAssertions({
    assertions: job.scenario.assertions,
    toolEvents: harnessResult.toolEvents,
  });
  const passed = assertionResults.every((result) => result.passed);

  return buildResult(job, {
    status: passed ? 'passed' : 'assertion_failed',
    workDir,
    setupResult,
    artifacts,
    harnessOutput,
    harnessResult,
    assertionResults,
  });
}

async function createWorkDir(scratchRoot: string | undefined): Promise<string> {
  return mkdtemp(join(scratchRoot ?? tmpdir(), 'dynobox-job-'));
}

function buildResult(
  job: LocalRunnerJob,
  result: Omit<
    LocalRunnerResult,
    | 'jobId'
    | 'scenarioId'
    | 'iteration'
    | 'passed'
    | 'assertionResults'
    | 'diagnostics'
  > & {
    assertionResults?: AssertionResult[];
    diagnostics?: string[];
  },
): LocalRunnerResult {
  const assertionResults = result.assertionResults ?? [];
  const diagnostics = result.diagnostics ?? [];
  return {
    jobId: job.id,
    scenarioId: job.scenario.id,
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
    artifacts: result.artifacts,
    assertionResults,
    diagnostics,
  };
}

function setupFailureDiagnostic(setupResult: SetupResult): string {
  const failed = setupResult.logs.find((log) => log.exitCode !== 0);
  if (failed === undefined) return 'Scenario setup failed.';

  const stderr = failed.stderr.trim();
  return stderr.length === 0
    ? `Setup command failed with exit code ${failed.exitCode}: ${failed.command}`
    : `Setup command failed with exit code ${failed.exitCode}: ${failed.command}\n${stderr}`;
}

function harnessExitDiagnostic(
  harnessResult: HarnessResult,
  harnessOutput: HarnessRunOutput,
): string {
  const stderr = harnessOutput.stderr.trim();
  return stderr.length === 0
    ? `Harness exited with code ${harnessResult.exitCode}.`
    : `Harness exited with code ${harnessResult.exitCode}: ${stderr}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
