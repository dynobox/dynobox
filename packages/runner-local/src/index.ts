import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {type AssertionResult, evaluateAssertions} from '@dynobox/evaluators';
import type {HarnessId, IrScenario} from '@dynobox/sdk';

import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './harnesses/index.js';
import type {SetupResult} from './setup.js';
import {runScenarioSetup} from './setup.js';

export type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
  ToolKind,
} from './harnesses/index.js';
export type {
  ClaudeCodeHarnessOptions,
  CodexHarnessOptions,
} from './harnesses/index.js';
export {
  ClaudeCodeHarness,
  CodexHarness,
  FakeHarness,
  normalizeToolKind,
} from './harnesses/index.js';
export type {RunSetupOptions, SetupCommandLog, SetupResult} from './setup.js';
export {runScenarioSetup, runSetup} from './setup.js';

export type LocalRunnerJob = {
  id: string;
  scenario: IrScenario;
  harness: HarnessId;
  model?: string;
  iteration: number;
};

export type RunJobProgressEvent =
  | {
      type: 'setup.started';
      job: LocalRunnerJob;
      commandCount: number;
    }
  | {
      type: 'setup.completed';
      job: LocalRunnerJob;
      setupResult: SetupResult;
    }
  | {
      type: 'harness.started';
      job: LocalRunnerJob;
      harnessId: string;
    }
  | {
      type: 'harness.completed';
      job: LocalRunnerJob;
      harnessId: string;
      success: boolean;
      toolCount: number;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: 'harness.tool';
      job: LocalRunnerJob;
      harnessId: string;
      toolEvent: ToolEvent;
      toolCount: number;
    }
  | {
      type: 'assertions.started';
      job: LocalRunnerJob;
      assertionCount: number;
    }
  | {
      type: 'assertions.completed';
      job: LocalRunnerJob;
      assertionResults: AssertionResult[];
    };

export type RunJobOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onProgress?: (event: RunJobProgressEvent) => void;
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

export type LocalRunnerTiming = {
  setupMs: number;
  harnessMs: number;
  assertionsMs: number;
  totalMs: number;
};

export type LocalRunnerResult = {
  jobId: string;
  scenarioId: string;
  harness: HarnessId;
  model?: string;
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
  timing: LocalRunnerTiming;
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

  emitProgress(options, {
    type: 'setup.started',
    job,
    commandCount: job.scenario.setup.length,
  });
  const setupResult = await runScenarioSetup(setupOptions);
  const setupMs = setupDurationMs(setupResult);
  emitProgress(options, {type: 'setup.completed', job, setupResult});
  if (!setupResult.success) {
    return buildResult(job, {
      status: 'setup_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [setupFailureDiagnostic(setupResult)],
      timing: buildTiming({setupMs}),
    });
  }

  emitProgress(options, {
    type: 'harness.started',
    job,
    harnessId: job.harness,
  });
  const harness = options.harnesses?.find(
    (candidate) => candidate.id === job.harness,
  );
  if (harness === undefined) {
    emitProgress(options, {
      type: 'harness.completed',
      job,
      harnessId: job.harness,
      success: false,
      toolCount: 0,
    });
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [
        `No harness registered for scenario harness "${job.harness}".`,
      ],
      timing: buildTiming({setupMs}),
    });
  }

  let harnessOutput: HarnessRunOutput;
  const harnessStartedAt = Date.now();
  let liveToolCount = 0;
  try {
    const harnessInput = {
      prompt: job.scenario.prompt,
      workDir,
      env: options.env ?? {},
      ...(job.model === undefined ? {} : {model: job.model}),
      onToolEvent: (toolEvent: ToolEvent) => {
        liveToolCount += 1;
        emitProgress(options, {
          type: 'harness.tool',
          job,
          harnessId: harness.id,
          toolEvent,
          toolCount: liveToolCount,
        });
      },
    };
    harnessOutput = await harness.run(
      options.timeoutMs === undefined
        ? harnessInput
        : {...harnessInput, timeoutMs: options.timeoutMs},
    );
  } catch (error) {
    emitProgress(options, {
      type: 'harness.completed',
      job,
      harnessId: harness.id,
      success: false,
      toolCount: liveToolCount,
    });
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [
        `Harness "${harness.id}" failed to run: ${errorMessage(error)}`,
      ],
      timing: buildTiming({
        setupMs,
        harnessMs: Date.now() - harnessStartedAt,
      }),
    });
  }

  let harnessResult: HarnessResult;
  try {
    harnessResult = harness.extractResult(harnessOutput);
  } catch (error) {
    emitProgress(options, {
      type: 'harness.completed',
      job,
      harnessId: harness.id,
      success: false,
      toolCount: liveToolCount,
      exitCode: harnessOutput.exitCode,
      durationMs: harnessOutput.durationMs,
    });
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      harnessOutput,
      diagnostics: [
        `Harness "${harness.id}" failed to extract result: ${errorMessage(error)}`,
      ],
      timing: buildTiming({
        setupMs,
        harnessMs: harnessOutput.durationMs,
      }),
    });
  }

  if (harnessResult.exitCode !== 0) {
    emitProgress(options, {
      type: 'harness.completed',
      job,
      harnessId: harness.id,
      success: false,
      toolCount: liveToolCount,
      exitCode: harnessResult.exitCode,
      durationMs: harnessResult.durationMs,
    });
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      harnessOutput,
      harnessResult,
      diagnostics: [harnessExitDiagnostic(harnessResult, harnessOutput)],
      timing: buildTiming({
        setupMs,
        harnessMs: harnessResult.durationMs,
      }),
    });
  }

  emitProgress(options, {
    type: 'harness.completed',
    job,
    harnessId: harness.id,
    success: true,
    toolCount: harnessResult.toolEvents.length,
    exitCode: harnessResult.exitCode,
    durationMs: harnessResult.durationMs,
  });
  emitProgress(options, {
    type: 'assertions.started',
    job,
    assertionCount: job.scenario.assertions.length,
  });
  const assertionsStartedAt = Date.now();
  const assertionResults = evaluateAssertions({
    assertions: job.scenario.assertions,
    toolEvents: harnessResult.toolEvents,
    workDir,
    transcript: harnessResult.transcript,
    finalMessage: harnessResult.finalMessage,
  });
  const assertionsMs = Date.now() - assertionsStartedAt;
  emitProgress(options, {
    type: 'assertions.completed',
    job,
    assertionResults,
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
    timing: buildTiming({
      setupMs,
      harnessMs: harnessResult.durationMs,
      assertionsMs,
    }),
  });
}

async function createWorkDir(scratchRoot: string | undefined): Promise<string> {
  return mkdtemp(join(scratchRoot ?? tmpdir(), 'dynobox-job-'));
}

function emitProgress(
  options: RunJobOptions,
  event: RunJobProgressEvent,
): void {
  options.onProgress?.(event);
}

function buildResult(
  job: LocalRunnerJob,
  result: Omit<
    LocalRunnerResult,
    | 'jobId'
    | 'scenarioId'
    | 'harness'
    | 'iteration'
    | 'passed'
    | 'assertionResults'
    | 'diagnostics'
    | 'timing'
  > & {
    assertionResults?: AssertionResult[];
    diagnostics?: string[];
    timing: LocalRunnerTiming;
  },
): LocalRunnerResult {
  const assertionResults = result.assertionResults ?? [];
  const diagnostics = result.diagnostics ?? [];
  return {
    jobId: job.id,
    scenarioId: job.scenario.id,
    harness: job.harness,
    ...(job.model === undefined ? {} : {model: job.model}),
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
    timing: result.timing,
  };
}

function setupDurationMs(setupResult: SetupResult): number {
  return setupResult.logs.reduce((total, log) => total + log.durationMs, 0);
}

function buildTiming(input: {
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
