import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  type AssertionResult,
  evaluateAssertions,
  type HttpEvent,
} from '@dynobox/evaluators';
import type {HarnessId, PermissionMode} from '@dynobox/sdk';
import type {IrScenario} from '@dynobox/sdk/ir';

import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './harnesses/index.js';
import type {HttpCapture} from './http/proxy.js';
import {startHttpCapture} from './http/proxy.js';
import type {SetupResult} from './setup.js';
import {runScenarioFixtures, runScenarioSetup} from './setup.js';

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
export type {HttpEvent};
export {ensureDynoboxCA} from './http/ca.js';
export {buildHttpRoutes, matchHttpEndpointId} from './http/events.js';
export type {
  RunFixturesOptions,
  RunSetupOptions,
  SetupCommandLog,
  SetupResult,
} from './setup.js';
export {
  runFixtures,
  runScenarioFixtures,
  runScenarioSetup,
  runSetup,
} from './setup.js';

/** One compiled scenario/harness/iteration unit scheduled by the CLI. */
export type LocalRunnerJob = {
  id: string;
  scenario: IrScenario;
  harness: HarnessId;
  model?: string;
  permissionMode?: PermissionMode;
  iteration: number;
};

/** Progress events emitted while `runJob` advances through setup/harness/assertions. */
export type RunJobProgressEvent =
  | {
      type: 'fixtures.started';
      job: LocalRunnerJob;
      fixturesCount: number;
    }
  | {
      type: 'fixtures.completed';
      job: LocalRunnerJob;
      fixturesResult: SetupResult;
    }
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

/** Runtime options for local execution of one job. */
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

/** Artifact produced by local execution and surfaced in debug output. */
export type LocalArtifact = {
  kind: 'work_dir';
  path: string;
};

/** Timing breakdown for setup, harness execution, and assertions. */
export type LocalRunnerTiming = {
  setupMs: number;
  harnessMs: number;
  assertionsMs: number;
  totalMs: number;
};

export type LocalRunnerWarning = {
  kind: 'permission_denied';
  message: string;
  tool?: {
    kind: string;
    rawName: string;
    command?: string;
  };
};

/** Structured result returned by `runJob` for rendering and summaries. */
export type LocalRunnerResult = {
  jobId: string;
  scenarioId: string;
  harness: HarnessId;
  model?: string;
  permissionMode?: PermissionMode;
  iteration: number;
  status: LocalRunnerStatus;
  passed: boolean;
  workDir: string;
  setupResult: SetupResult;
  harnessOutput?: HarnessRunOutput;
  harnessResult?: HarnessResult;
  httpEvents: readonly HttpEvent[];
  artifacts: LocalArtifact[];
  assertionResults: AssertionResult[];
  diagnostics: string[];
  warnings: LocalRunnerWarning[];
  timing: LocalRunnerTiming;
};

/**
 * Run one compiled scenario/harness job locally.
 *
 * The runner creates an isolated work directory, executes setup commands,
 * invokes the selected harness, extracts tool/transcript/final-message data,
 * evaluates assertions, and returns a structured result for renderers.
 */
export async function runJob(
  job: LocalRunnerJob,
  options: RunJobOptions = {},
): Promise<LocalRunnerResult> {
  const workDir = await createWorkDir(options.scratchRoot);
  const artifacts: LocalArtifact[] = [{kind: 'work_dir', path: workDir}];

  emitProgress(options, {
    type: 'fixtures.started',
    job,
    fixturesCount: job.scenario.fixtures.length,
  });
  const fixturesResult = await runScenarioFixtures({
    scenario: job.scenario,
    workDir,
  });
  emitProgress(options, {type: 'fixtures.completed', job, fixturesResult});
  if (!fixturesResult.success) {
    const setupMs = setupDurationMs(fixturesResult);
    return buildResult(job, {
      status: 'setup_failed',
      workDir,
      setupResult: fixturesResult,
      artifacts,
      diagnostics: [setupFailureDiagnostic(fixturesResult)],
      timing: buildTiming({setupMs}),
    });
  }

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
  const commandSetupResult = await runScenarioSetup(setupOptions);
  const setupResult: SetupResult = {
    success: commandSetupResult.success,
    logs: [...fixturesResult.logs, ...commandSetupResult.logs],
  };
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

  let httpCapture: HttpCapture | undefined;
  try {
    httpCapture = await startHttpCapture(job.scenario);
  } catch (error) {
    emitProgress(options, {
      type: 'harness.completed',
      job,
      harnessId: harness.id,
      success: false,
      toolCount: 0,
    });
    return buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      diagnostics: [`HTTP capture failed to start: ${errorMessage(error)}`],
      timing: buildTiming({setupMs}),
    });
  }

  let harnessOutput: HarnessRunOutput;
  const harnessStartedAt = Date.now();
  let liveToolCount = 0;
  try {
    const harnessEnv = {...(options.env ?? {}), ...(httpCapture?.env ?? {})};
    const harnessInput = {
      prompt: job.scenario.prompt,
      workDir,
      env: harnessEnv,
      ...(job.model === undefined ? {} : {model: job.model}),
      ...(job.permissionMode === undefined
        ? {}
        : {permissionMode: job.permissionMode}),
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
    await stopHttpCapture(httpCapture);
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
      httpEvents: httpCapture?.events ?? [],
      timing: buildTiming({
        setupMs,
        harnessMs: Date.now() - harnessStartedAt,
      }),
    });
  }
  await stopHttpCapture(httpCapture);
  const httpEvents = httpCapture?.events ?? [];

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
      httpEvents,
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
      httpEvents,
      diagnostics: [harnessExitDiagnostic(harnessResult, harnessOutput)],
      warnings: [
        ...permissionWarningsFromToolEvents(harnessResult.toolEvents),
        ...permissionWarningsFromHarnessFailure(harnessOutput, harnessResult),
      ],
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
    httpEvents,
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
  const warnings = permissionWarningsFromToolEvents(harnessResult.toolEvents);

  return buildResult(job, {
    status: passed ? 'passed' : 'assertion_failed',
    workDir,
    setupResult,
    artifacts,
    harnessOutput,
    harnessResult,
    httpEvents,
    assertionResults,
    warnings,
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

async function stopHttpCapture(
  httpCapture: HttpCapture | undefined,
): Promise<void> {
  if (httpCapture === undefined) return;
  await httpCapture.stop();
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
    | 'httpEvents'
    | 'assertionResults'
    | 'diagnostics'
    | 'warnings'
    | 'timing'
  > & {
    assertionResults?: AssertionResult[];
    diagnostics?: string[];
    warnings?: LocalRunnerWarning[];
    httpEvents?: readonly HttpEvent[];
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
    artifacts: result.artifacts,
    assertionResults,
    diagnostics,
    warnings,
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

function permissionWarningsFromToolEvents(
  toolEvents: readonly ToolEvent[],
): LocalRunnerWarning[] {
  return dedupeWarnings(
    toolEvents.flatMap((event) => {
      if (event.status !== 'failure') return [];
      if (event.message === undefined) return [];
      if (!isPermissionDeniedText(event.message)) return [];
      return [permissionWarningForTool(event)];
    }),
  );
}

function permissionWarningsFromHarnessFailure(
  harnessOutput: HarnessRunOutput,
  harnessResult: HarnessResult,
): LocalRunnerWarning[] {
  const text = [harnessOutput.stderr, harnessResult.transcript]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join('\n');

  if (!isPermissionDeniedText(text)) return [];
  return [
    {
      kind: 'permission_denied',
      message:
        'Harness blocked an action. Use --permission-mode dangerous only for trusted evals that intentionally need this access.',
    },
  ];
}

function permissionWarningForTool(event: ToolEvent): LocalRunnerWarning {
  return {
    kind: 'permission_denied',
    message:
      'Harness blocked a tool action. Use --permission-mode dangerous only for trusted evals that intentionally need this access.',
    tool: {
      kind: event.kind,
      rawName: event.rawName,
      ...(isShellToolEvent(event) ? {command: event.command} : {}),
    },
  };
}

function dedupeWarnings(
  warnings: readonly LocalRunnerWarning[],
): LocalRunnerWarning[] {
  const seen = new Set<string>();
  const deduped: LocalRunnerWarning[] = [];
  for (const warning of warnings) {
    const key = [
      warning.kind,
      warning.tool?.kind ?? '',
      warning.tool?.rawName ?? '',
      warning.tool?.command ?? '',
      warning.message,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(warning);
  }
  return deduped;
}

function isShellToolEvent(event: ToolEvent): event is ShellToolEvent {
  return event.kind === 'shell' && 'command' in event;
}

function isPermissionDeniedText(value: string): boolean {
  return PERMISSION_DENIED_PATTERNS.some((pattern) => pattern.test(value));
}

const PERMISSION_DENIED_PATTERNS = [
  /\bpermission denied\b/i,
  /\boperation not permitted\b/i,
  /\bnot approved\b/i,
  /\bapproval denied\b/i,
  /\brequires approval\b/i,
  /\bdenied by policy\b/i,
  /\bblocked by sandbox\b/i,
  /\bsandbox denied\b/i,
] as const;
