import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  assertionRequiresVerify,
  type AssertionResult,
  captureArtifactBaselines,
  evaluateAssertions,
  preEvaluateAnyOfObservationBranches,
} from '@dynobox/evaluators';

import {
  errorMessage,
  harnessExitDiagnostic,
  setupFailureDiagnostic,
} from './diagnostics.js';
import type {
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './harnesses/index.js';
import type {HttpCapture} from './http/proxy.js';
import {startHttpCapture} from './http/proxy.js';
import {
  permissionWarningsFromHarnessFailure,
  permissionWarningsFromToolEvents,
} from './permissionWarnings.js';
import {buildResult, buildTiming, setupDurationMs} from './result.js';
import type {
  LocalArtifact,
  LocalRunnerJob,
  LocalRunnerResult,
  RunJobOptions,
  RunJobProgressEvent,
} from './runTypes.js';
import type {SetupResult} from './setup.js';
import {runScenarioFixtures, runScenarioSetup} from './setup.js';
import {runVerifyCommands} from './verify.js';

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
  OpenCodeHarnessOptions,
} from './harnesses/index.js';
export {
  ClaudeCodeHarness,
  CodexHarness,
  FakeHarness,
  normalizeToolKind,
  OpenCodeHarness,
} from './harnesses/index.js';
export {ensureDynoboxCA} from './http/ca.js';
export {buildHttpRoutes, matchHttpEndpointId} from './http/events.js';
export type {
  LocalArtifact,
  LocalRunnerJob,
  LocalRunnerResult,
  LocalRunnerStatus,
  LocalRunnerTiming,
  LocalRunnerWarning,
  RunJobOptions,
  RunJobProgressEvent,
} from './runTypes.js';
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
export {runVerifyCommands} from './verify.js';
export type {HttpEvent} from '@dynobox/evaluators';

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

  // Capture unchanged baselines after fixtures/setup succeed and before the
  // harness can mutate the workdir. Snapshot failures stay assertion-level.
  const artifactBaselines = captureArtifactBaselines(
    job.scenario.assertions,
    workDir,
  );

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

  const harnessVersion = Promise.resolve()
    .then(() => harness.version?.() ?? null)
    .catch(() => null);

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
      harnessVersion: await harnessVersion,
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
      harnessVersion: await harnessVersion,
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
      harnessVersion: await harnessVersion,
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
      harnessVersion: await harnessVersion,
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
  const observationInput = {
    toolEvents: harnessResult.toolEvents,
    httpEvents,
    workDir,
    transcript: harnessResult.transcript,
    finalMessage: harnessResult.finalMessage,
    artifactBaselines,
  };
  // Cache observation branches before verification commands can mutate the
  // workdir (including nested anyOf verify branches).
  const anyOfObservationBranches = preEvaluateAnyOfObservationBranches(
    job.scenario.assertions,
    observationInput,
  );
  const preVerifyAssertions = job.scenario.assertions.filter(
    (assertion) => !assertionRequiresVerify(assertion),
  );
  const postVerifyAssertions = job.scenario.assertions.filter(
    assertionRequiresVerify,
  );
  const nonVerifyAssertionResults = evaluateAssertions({
    assertions: preVerifyAssertions,
    ...observationInput,
    anyOfObservationBranches,
  });
  const verifyOptions: Parameters<typeof runVerifyCommands>[0] = {
    scenario: job.scenario,
    workDir,
  };
  if (options.env !== undefined) verifyOptions.env = options.env;
  const verifyCommandResults = await runVerifyCommands(verifyOptions);
  const verifyAssertionResults = evaluateAssertions({
    assertions: postVerifyAssertions,
    ...observationInput,
    verifyCommandResults,
    anyOfObservationBranches,
  });
  const resultsByAssertionId = new Map<string, AssertionResult[]>();
  for (const result of [
    ...nonVerifyAssertionResults,
    ...verifyAssertionResults,
  ]) {
    const results = resultsByAssertionId.get(result.assertionId) ?? [];
    results.push(result);
    resultsByAssertionId.set(result.assertionId, results);
  }
  const assertionResults = job.scenario.assertions.map((assertion) => {
    const result = resultsByAssertionId.get(assertion.id)?.shift();
    if (result === undefined) {
      throw new Error(`Missing assertion result for ${assertion.id}.`);
    }
    return result;
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
    harnessVersion: await harnessVersion,
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
