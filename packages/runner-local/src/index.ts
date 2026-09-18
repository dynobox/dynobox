import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';

import {
  assertionRequiresVerify,
  type AssertionResult,
  captureArtifactBaselines,
  evaluateAssertions,
  preEvaluateAnyOfObservationBranches,
} from '@dynobox/evaluators';
import {DynoboxConfigError} from '@dynobox/sdk/compiler';
import {irScenarioSchema, type McpObservation} from '@dynobox/sdk/ir';
import {execa} from 'execa';

import {type CliMockController, startCliMockController} from './cliMocks.js';
import {
  errorMessage,
  harnessExitDiagnostic,
  setupFailureDiagnostic,
} from './diagnostics.js';
import {ClaudeCodeMcpError} from './harnesses/claudeCodeMcp.js';
import {CodexMcpError} from './harnesses/codexMcp.js';
import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './harnesses/index.js';
import type {PreparedMcpHarness} from './harnesses/types.js';
import type {HttpCapture} from './http/proxy.js';
import {startHttpCapture} from './http/proxy.js';
import {
  type McpMockController,
  startMcpMockController,
} from './mcpMocks/controller.js';
import {
  permissionWarningsFromHarnessFailure,
  permissionWarningsFromToolEvents,
} from './permissionWarnings.js';
import {buildResult, buildTiming, setupDurationMs} from './result.js';
import type {
  LocalArtifact,
  LocalMcpSummary,
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
  AntigravityHarnessOptions,
  ClaudeCodeHarnessOptions,
  CodexHarnessOptions,
  CursorHarnessOptions,
  OpenCodeHarnessOptions,
  PiHarnessOptions,
} from './harnesses/index.js';
export {
  AntigravityHarness,
  ClaudeCodeHarness,
  CodexHarness,
  CursorHarness,
  FakeHarness,
  normalizeToolKind,
  OpenCodeHarness,
  PiHarness,
} from './harnesses/index.js';
export {ensureDynoboxCA} from './http/ca.js';
export {buildHttpRoutes, matchHttpEndpointId} from './http/events.js';
export type {
  CliMockCall,
  LocalArtifact,
  LocalMcpSummary,
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

/** Reject unsupported MCP runs before scheduling or creating a workspace. */
export function assertMcpExecutionSupported(
  scenario: LocalRunnerJob['scenario'],
  harness?: LocalRunnerJob['harness'],
  experimentalMcp = false,
): void {
  if (
    scenario.mcpMocks !== undefined ||
    scenario.assertions.some(
      (assertion) =>
        assertion.type === 'mcp.called' ||
        assertion.type === 'mcp.notCalled' ||
        (assertion.type === 'anyOf' &&
          assertion.steps.some(
            (step) =>
              step.type === 'mcp.called' || step.type === 'mcp.notCalled',
          )),
    )
  ) {
    if (
      !experimentalMcp ||
      (harness === undefined
        ? scenario.harnesses.map((entry) => entry.id)
        : [harness]
      ).some((id) => id !== 'claude-code' && id !== 'codex')
    ) {
      throw new DynoboxConfigError(
        'MCP mock execution is not enabled for this harness. Use dynolocal with claude-code or codex for experimental local execution.',
      );
    }
    if (
      scenario.mcpMocks === undefined ||
      !irScenarioSchema.safeParse(scenario).success
    )
      throw new DynoboxConfigError(
        'Invalid MCP mock scenario or assertion reference.',
      );
  }
}

/**
 * Run one compiled scenario/harness job locally.
 *
 * Pipeline (early exits return a structured result and skip later steps):
 *   1. Create work directory
 *   2. Materialize fixtures
 *   3. Run setup commands (real PATH — CLI mocks not installed yet)
 *   4. Resolve harness + start version probe (real PATH)
 *   5. Install CLI mocks when configured (after collision checks)
 *   6. Capture artifact baselines + start HTTP capture
 *   7. Invoke harness (mocked PATH / HTTP proxy env)
 *   8. Finalize harness-phase mocks, extract result, check exit code
 *   9. Evaluate observation assertions from harness-phase data only
 *  10. Run verify commands in a new mock phase (mocked PATH)
 *  11. Evaluate verify assertions and decide pass/fail
 *  12. Always stop HTTP capture + CLI mocks in `finally`
 *
 * Returns a structured result for CLI renderers and upload.
 */
export async function runJob(
  job: LocalRunnerJob,
  options: RunJobOptions = {},
): Promise<LocalRunnerResult> {
  assertMcpExecutionSupported(
    job.scenario,
    job.harness,
    options.experimentalMcp,
  );
  const usesMcp = job.scenario.mcpMocks !== undefined;
  for (const permission of options.allowedMcpTools ?? []) {
    const mocks = job.scenario.mcpMocks;
    if (
      mocks === undefined ||
      !Object.hasOwn(mocks, permission.server) ||
      !Object.hasOwn(mocks[permission.server]!.tools, permission.tool)
    )
      throw new DynoboxConfigError(
        'MCP tool permissions must name a declared mock server/tool.',
      );
  }
  if (usesMcp) {
    if (
      !options.harnesses?.find((candidate) => candidate.id === job.harness)
        ?.prepareMcp
    )
      throw new DynoboxConfigError(
        'The registered harness does not implement isolated MCP execution.',
      );
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new DynoboxConfigError(
        'MCP execution timeout must be a positive integer.',
      );
    // Snapshot definitions/assertions before user setup and asynchronous work.
    job = {...job, scenario: irScenarioSchema.parse(job.scenario)};
  }
  // --- 1. Work directory ---------------------------------------------------
  const workDir = await createWorkDir(options.scratchRoot);
  const artifacts: LocalArtifact[] = [{kind: 'work_dir', path: workDir}];

  // --- 2. Fixtures ---------------------------------------------------------
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

  // --- 3. Setup commands (real PATH; mocks not installed) ------------------
  const setupOptions: Parameters<typeof runScenarioSetup>[0] = {
    scenario: job.scenario,
    workDir,
  };
  if (options.env !== undefined) setupOptions.env = options.env;
  if (usesMcp && options.signal !== undefined)
    setupOptions.signal = options.signal;

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

  // --- 4. Resolve harness + version probe (real PATH) ----------------------
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

  // MCP probes must use the same exclusive configuration and environment as
  // execution. The prepared adapter reports that version with its output.
  let harnessVersion = usesMcp
    ? Promise.resolve<string | null>(null)
    : Promise.resolve()
        .then(() => harness.version?.() ?? null)
        .catch(() => null);
  const mcpDeadline = Date.now() + (options.timeoutMs ?? 120_000);
  const remainingMcpTime = () => {
    const remaining = mcpDeadline - Date.now();
    if (remaining <= 0 || options.signal?.aborted)
      throw new ClaudeCodeMcpError('execution_failed');
    return remaining;
  };
  let preparedMcp: PreparedMcpHarness | undefined;
  if (usesMcp) {
    try {
      remainingMcpTime();
      preparedMcp = await harness.prepareMcp!({
        workDir,
        env: options.env ?? {},
      });
    } catch {
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
        mcp: {
          ready: false,
          finalized: false,
          failures: ['configuration_failed'],
          calls: [],
        },
        diagnostics: ['MCP preparation failed.'],
        timing: buildTiming({setupMs}),
      });
    }
  }

  // --- 5. Install CLI mocks (if any) ---------------------------------------
  // Reject mocks that would shadow the harness binary itself (e.g. mock
  // "claude" while running the Claude Code harness).
  if (
    harness.executable !== undefined &&
    Object.hasOwn(job.scenario.cliMocks, basename(harness.executable))
  ) {
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
      diagnostics: [
        `CLI mock "${harness.executable}" conflicts with harness "${harness.id}".`,
      ],
      timing: buildTiming({setupMs}),
    });
  }

  const hasCliMocks = Object.keys(job.scenario.cliMocks).length > 0;
  // Needed so package-script PATH injection preserves the project's script-shell.
  const baseScriptShell = hasCliMocks
    ? await resolvePackageScriptShell(workDir, options.env)
    : undefined;
  let cliMockController: CliMockController | undefined;
  try {
    if (hasCliMocks) {
      cliMockController = await startCliMockController(job.scenario.cliMocks);
      await cliMockController.install();
    }
  } catch (error) {
    await cliMockController?.stop();
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
      diagnostics: [`CLI mocks failed to initialize: ${errorMessage(error)}`],
      timing: buildTiming({setupMs}),
    });
  }

  // --- 6–12. Construct the final result only after cleanup outcomes are known.
  let httpCapture: HttpCapture | undefined;
  let mcpController: McpMockController | undefined;
  let mcpObservation: McpObservation | undefined;
  let mcpReady = false;
  const mcpFailures = new Set<LocalMcpSummary['failures'][number]>();
  const recordMcpError = (error: unknown) => {
    mcpFailures.add(
      error instanceof ClaudeCodeMcpError || error instanceof CodexMcpError
        ? error.category
        : 'execution_failed',
    );
    if (error instanceof ClaudeCodeMcpError && error.priorCategory)
      mcpFailures.add(error.priorCategory);
  };
  const finalizeMcp = async (succeeded: boolean) => {
    if (mcpController === undefined || mcpObservation !== undefined) return;
    try {
      mcpObservation = await mcpController.finalize({
        harnessReady: mcpReady,
        harnessSucceeded: succeeded,
      });
      for (const failure of mcpObservation.failures) mcpFailures.add(failure);
    } catch {
      mcpFailures.add('cleanup_failed');
    }
  };
  let result: LocalRunnerResult;
  try {
    result = await executeHarnessAndVerify(harness);
  } catch (error) {
    if (!usesMcp) throw error;
    recordMcpError(error);
    result = buildResult(job, {
      status: 'harness_failed',
      workDir,
      setupResult,
      artifacts,
      harnessVersion: await harnessVersion,
      diagnostics: ['MCP job execution failed.'],
      timing: buildTiming({setupMs}),
    });
  } finally {
    await finalizeMcp(false);
    const cleanup = await Promise.allSettled([
      stopHttpCapture(httpCapture),
      cliMockController?.stop(),
    ]);
    if (usesMcp && cleanup.some((outcome) => outcome.status === 'rejected'))
      mcpFailures.add('cleanup_failed');
  }
  if (usesMcp) {
    result.mcp = {
      ready: mcpObservation?.ready ?? false,
      finalized: mcpObservation?.finalized ?? false,
      failures: [...mcpFailures],
      calls: (mcpObservation?.calls ?? []).map(
        ({sequence, server, tool, category}) => ({
          sequence,
          server,
          tool,
          category,
        }),
      ),
    };
    if (mcpFailures.size > 0) {
      result.status = 'harness_failed';
      result.passed = false;
      result.diagnostics.push(
        ...[...mcpFailures].map((failure) => `MCP ${failure}.`),
      );
    }
  }
  return result;

  async function executeHarnessAndVerify(
    harness: Harness,
  ): Promise<LocalRunnerResult> {
    // --- 6. Baselines + HTTP capture ---------------------------------------
    const cliMockEnv =
      cliMockController?.env(
        options.env?.PATH ?? process.env.PATH ?? '',
        baseScriptShell,
        {...process.env, ...options.env},
      ) ?? {};
    const artifactBaselines = captureArtifactBaselines(
      job.scenario.assertions,
      workDir,
    );

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

    // --- 7. Run harness (mocked PATH + HTTP proxy env) ---------------------
    let harnessOutput: HarnessRunOutput;
    const harnessStartedAt = Date.now();
    let liveToolCount = 0;
    try {
      const harnessEnv = {
        ...(options.env ?? {}),
        ...(httpCapture?.env ?? {}),
        ...cliMockEnv,
      };
      const harnessInput = {
        ...(options.allowedMcpTools === undefined
          ? {}
          : {allowedMcpTools: options.allowedMcpTools}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        prompt: job.scenario.prompt,
        workDir,
        env: harnessEnv,
        ...(cliMockController === undefined ? {} : {cliMocksEnabled: true}),
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
      if (preparedMcp !== undefined) {
        remainingMcpTime();
        mcpController = await startMcpMockController(job.scenario.mcpMocks);
        const servers = Object.fromEntries(
          Object.entries(mcpController.urls).map(([name, url]) => [
            name,
            {
              url,
              tools: Object.keys(job.scenario.mcpMocks![name]!.tools),
            },
          ]),
        );
        const run = await preparedMcp.run(
          {...harnessInput, timeoutMs: remainingMcpTime()},
          servers,
        );
        harnessOutput = run.output;
        mcpReady = run.harnessReady;
        const version = harnessOutput.metadata?.mcpHarnessVersion;
        if (typeof version === 'string')
          harnessVersion = Promise.resolve(version);
      } else {
        harnessOutput = await harness.run(
          options.timeoutMs === undefined
            ? harnessInput
            : {...harnessInput, timeoutMs: options.timeoutMs},
        );
      }
    } catch (error) {
      if (usesMcp) recordMcpError(error);
      await finalizeMcp(false);
      await cliMockController?.finalizePendingCalls();
      const cliMockFailures = cliMockController?.failures() ?? [];
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
          usesMcp
            ? 'MCP harness execution failed.'
            : `Harness "${harness.id}" failed to run: ${errorMessage(error)}`,
          ...cliMockFailures.map((failure) => failure.message),
        ],
        httpEvents: httpCapture?.events ?? [],
        cliMockCalls: cliMockController?.calls() ?? [],
        timing: buildTiming({
          setupMs,
          harnessMs: Date.now() - harnessStartedAt,
        }),
      });
    }

    // --- 8. Seal MCP evidence before verification can mutate the workspace.
    await finalizeMcp(harnessOutput.exitCode === 0);
    // --- Finalize other harness-phase mocks; extract + validate result -----
    await cliMockController?.finalizePendingCalls();
    const httpEvents = httpCapture?.events ?? [];
    // Stop proxy before verify so verification traffic is not recorded as
    // harness HTTP events. `finally` still calls stopHttpCapture safely.
    await stopHttpCapture(httpCapture);
    httpCapture = undefined;

    // Lifecycle failures (exhaustion, pending calls, handler errors) fail the
    // harness even when the process exited 0.
    const harnessCliMockFailures = cliMockController?.failures() ?? [];
    if (harnessCliMockFailures.length > 0 || mcpFailures.size > 0) {
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
        cliMockCalls: cliMockController?.calls() ?? [],
        diagnostics: harnessCliMockFailures.map((failure) => failure.message),
        timing: buildTiming({
          setupMs,
          harnessMs: harnessOutput.durationMs,
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
        harnessVersion: await harnessVersion,
        harnessOutput,
        httpEvents,
        cliMockCalls: cliMockController?.calls() ?? [],
        diagnostics: [
          usesMcp
            ? 'MCP harness result extraction failed.'
            : `Harness "${harness.id}" failed to extract result: ${errorMessage(error)}`,
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
        cliMockCalls: cliMockController?.calls() ?? [],
        diagnostics: [
          usesMcp
            ? 'MCP harness exited unsuccessfully.'
            : harnessExitDiagnostic(harnessResult, harnessOutput),
        ],
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

    // --- 9. Observation assertions (harness-phase data only) ---------------
    emitProgress(options, {
      type: 'assertions.started',
      job,
      assertionCount: job.scenario.assertions.length,
    });
    const assertionsStartedAt = Date.now();
    // Snapshot mock calls before verify so command.called / similar assertions
    // only see harness-phase invocations. The result payload still gets the
    // full ordered log after verify (step 11).
    const harnessCliMockCalls = cliMockController?.calls() ?? [];
    const observationInput = {
      ...(mcpObservation === undefined ? {} : {mcpObservation}),
      toolEvents: harnessResult.toolEvents,
      httpEvents,
      cliMockCalls: harnessCliMockCalls,
      cliMockExecutableNames:
        cliMockController?.executableNames ??
        Object.keys(job.scenario.cliMocks),
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

    // --- 10. Verify commands (new mock phase, mocked PATH) -----------------
    const verifyOptions: Parameters<typeof runVerifyCommands>[0] = {
      scenario: job.scenario,
      workDir,
      ...(usesMcp && options.signal !== undefined
        ? {signal: options.signal}
        : {}),
    };
    // Open a new mock phase so verify traffic is recorded separately from the
    // harness-phase snapshot used above for observation assertions.
    cliMockController?.beginPhase();
    const verifyCliMockEnv =
      cliMockController?.env(
        options.env?.PATH ?? process.env.PATH ?? '',
        baseScriptShell,
        {...process.env, ...options.env},
      ) ?? {};
    if (options.env !== undefined || cliMockController !== undefined) {
      verifyOptions.env = {...(options.env ?? {}), ...verifyCliMockEnv};
    }
    if (usesMcp && options.signal?.aborted)
      throw new ClaudeCodeMcpError('execution_failed');
    const verifyCommandResults = await runVerifyCommands(verifyOptions);
    if (usesMcp && options.signal?.aborted)
      throw new ClaudeCodeMcpError('execution_failed');
    await cliMockController?.finalizePendingCalls();

    // --- 11. Verify assertions + pass/fail ---------------------------------
    // Still uses observationInput (harness-phase mocks), plus verify results.
    const verifyAssertionResults = evaluateAssertions({
      assertions: postVerifyAssertions,
      ...observationInput,
      verifyCommandResults,
      anyOfObservationBranches,
    });
    // Reassemble results in original assertion order (pre- and post-verify
    // evaluations were split above).
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
    // Mock lifecycle failures during verify (or leftover pending calls) fail
    // the run even when every assertion result is passing.
    const cliMockFailures = cliMockController?.failures() ?? [];
    emitProgress(options, {
      type: 'assertions.completed',
      job,
      assertionResults,
      verificationFailed: cliMockFailures.length > 0,
    });
    const passed =
      cliMockFailures.length === 0 &&
      assertionResults.every((result) => result.passed);
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
      harnessCliMockCallCount: harnessCliMockCalls.length,
      // Full ordered log (harness + verify phases) for renderers/debug.
      cliMockCalls: cliMockController?.calls() ?? [],
      assertionResults,
      verificationFailed: cliMockFailures.length > 0,
      diagnostics: cliMockFailures.map((failure) => failure.message),
      warnings,
      timing: buildTiming({
        setupMs,
        harnessMs: harnessResult.durationMs,
        assertionsMs,
      }),
    });
  }
}

async function createWorkDir(scratchRoot: string | undefined): Promise<string> {
  return mkdtemp(join(scratchRoot ?? tmpdir(), 'dynobox-job-'));
}

async function resolvePackageScriptShell(
  workDir: string,
  envOverrides: Record<string, string> | undefined,
): Promise<string> {
  const configured =
    normalizePackageScriptShell(envOverrides?.npm_config_script_shell) ??
    normalizePackageScriptShell(envOverrides?.NPM_CONFIG_SCRIPT_SHELL) ??
    normalizePackageScriptShell(process.env.npm_config_script_shell) ??
    normalizePackageScriptShell(process.env.NPM_CONFIG_SCRIPT_SHELL);
  if (configured !== undefined) return configured;

  try {
    const result = await execa('npm', ['config', 'get', 'script-shell'], {
      cwd: workDir,
      env: {...process.env, ...(envOverrides ?? {})},
      reject: false,
      stdin: 'ignore',
      timeout: 5_000,
    });
    const scriptShell = normalizePackageScriptShell(result.stdout);
    if (result.exitCode === 0 && scriptShell !== undefined) {
      return scriptShell;
    }
  } catch {
    // Fall back to the platform shell when npm config cannot be resolved.
  }
  return '/bin/sh';
}

function normalizePackageScriptShell(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized === 'null' ||
    normalized === 'undefined'
  ) {
    return undefined;
  }
  return normalized;
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
