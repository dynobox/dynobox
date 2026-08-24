/**
 * Action handler for `dynobox run [path]`.
 *
 * Top-level flow:
 *   1. Validate `--harness` overrides, resolve the discovery input path.
 *   2. Discover `*.dyno.{mjs,js,ts,yaml,...}` files (or use a single
 *      explicit file path verbatim).
 *   3. Load + compile each file, accumulating per-file errors.
 *   4. Build the full job list across every compiled IR.
 *   5. Choose the live (interactive) or static (batched) output path.
 *   6. Execute jobs, write transcript logs in debug mode, render output.
 *   7. Return whether any compile error or job failure occurred.
 *
 * Splitting `runLive` and `runStatic` keeps each path linear and easy to
 * read; both share the same job-iteration shape.
 */

import {basename, dirname, relative, resolve} from 'node:path';

import {
  type LocalRunnerJob,
  type LocalRunnerResult,
  runJob,
  type RunJobOptions,
} from '@dynobox/runner-local';
import {CommanderError} from 'commander';

import {assertionByIdForJobs, buildLocalRunnerJobs} from '../jobs.js';
import {
  createLiveDashboard,
  createSpinner,
  type LiveJobState,
  renderLiveProgressEvent,
  SPINNER_FRAMES,
} from '../live/index.js';
import {
  groupJobs,
  harnessLabelColumnWidth,
  renderDynoLine,
  renderHarnessGroupRow,
  renderIterationDetailLines,
  renderIterationResultLine,
  renderJobDetails,
  renderJsonRunOutput,
  renderRunConfigErrorMessage,
  renderRunHeader,
  renderRunningGroupRow,
  renderRunOutput,
  renderRunSummary,
  renderScenarioLine,
  renderSingleJobFailureDetails,
  type RowLabelOptions,
  type RunDynoGroup,
  uniqueHarnessLabels,
} from '../render/index.js';
import {createRenderContext, type RenderContext} from '../terminal/index.js';
import {reportConfigError} from '../util/reportConfigError.js';
import {
  type DebugLogPaths,
  hasDebugLogPaths,
  writeDebugLogs,
} from '../util/transcript.js';
import {unique} from '../util/unique.js';
import {resolveAuthToken} from './auth.js';
import {compileDynos, type DynoCompileSuccess} from './compileDynos.js';
import {
  discoverDynos,
  type DiscoverDynosResult,
  DYNO_FILE_SUFFIXES,
  DynoPathNotFoundError,
} from './discoverDynos.js';
import {shouldRenderLive} from './environment.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {
  fetchAuthenticatedIdentity,
  type IdentityResult,
  resolveApiUrl,
} from './identityApi.js';
import {
  buildRunJobOptions,
  validateHarnessOverrides,
  validateIterations,
  validateModelOverrides,
  validatePermissionModeOverride,
  validateReporterFormat,
  validateScenarioFilters,
} from './options.js';
import {runScenarioExecutions, type ScenarioExecution} from './runJobs.js';
import {resolveCustomUploadUrl, uploadRun} from './uploadRun.js';

const AUTH_PREFLIGHT_ATTEMPTS = 3;
const AUTH_PREFLIGHT_RETRY_BASE_DELAY_MS = 100;

export type RunCommandFlags = {
  harness?: string[];
  model?: string[];
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  reporter?: string;
  saveRun?: boolean;
  scenario?: string[];
  iterations?: string;
  permissionMode?: string;
  config?: string;
};

export type RunCommandActionInput = {
  /** Optional file/directory; falls back to the current working directory. */
  configPath: string | undefined;
  commandFlags: RunCommandFlags;
  options: ExecuteCliOptions;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
};

/**
 * Run the `run` subcommand end-to-end.
 *
 * @returns `true` if any job failed or any file failed to compile
 * (caller should set the run-failure exit code), `false` otherwise.
 */
export async function runCommandAction(
  input: RunCommandActionInput,
): Promise<boolean> {
  const {configPath, commandFlags, options, writeStdout, writeStderr} = input;
  const inputLabel = configPath ?? '.';
  const resolvedInputPath = resolve(inputLabel);

  const overrideHarnesses = validateOverrides(
    commandFlags.harness,
    inputLabel,
    writeStderr,
  );
  const overrideModels = validateModels(
    commandFlags.model,
    overrideHarnesses,
    inputLabel,
    writeStderr,
  );
  const permissionMode = validatePermissionMode(
    commandFlags.permissionMode,
    inputLabel,
    writeStderr,
  );
  const reporter = validateReporter(
    commandFlags.reporter,
    inputLabel,
    writeStderr,
  );
  const iterations = validateIterationCount(
    commandFlags.iterations,
    inputLabel,
    writeStderr,
  );
  const scenarioPatterns = validateScenarioFilters(commandFlags.scenario);

  // Fail fast when --save-run cannot authenticate before doing any expensive
  // local scenario work that would only fail during upload.
  if (
    commandFlags.saveRun === true &&
    resolveCustomUploadUrl(options.env) === null
  ) {
    await validateSaveRunAuth({inputLabel, env: options.env, writeStderr});
  }

  const {files, configPath: appliedConfigPath} = await discoverOrFail(
    configPath,
    resolvedInputPath,
    commandFlags.config,
    writeStderr,
  );
  if (files.length === 0) {
    const label = configPath ?? resolvedInputPath;
    writeStderr(
      renderRunConfigErrorMessage(
        label,
        `No *.dyno.{${DYNO_FILE_SUFFIXES}} files found under ${label}`,
      ),
    );
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'no dynos found',
    );
  }
  const {compiled, errors} = await compileDynos(files);

  for (const error of errors) {
    writeStderr(renderRunConfigErrorMessage(error.filePath, error.message));
  }

  if (compiled.length === 0) {
    // Every file failed to load or compile (or the only file passed was
    // bad). Per-file errors were already written above; signal the
    // standard config-error exit code.
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'no dynos compiled',
    );
  }

  // Jobs stay grouped by source dyno so the run upload can report each
  // dyno (and its target) separately; execution flattens them in order.
  const dynoGroups = compiled.map((entry) => ({
    entry,
    jobs: buildLocalRunnerJobs(
      entry.ir,
      buildJobOptions(
        overrideHarnesses,
        overrideModels,
        permissionMode,
        scenarioPatterns,
        iterations,
      ),
    ),
  }));
  const jobs = dynoGroups.flatMap((group) => group.jobs);
  if (jobs.length === 0 && scenarioPatterns !== undefined) {
    writeStderr(
      renderRunConfigErrorMessage(
        inputLabel,
        `No scenarios matched --scenario ${scenarioPatterns.map((pattern) => JSON.stringify(pattern)).join(', ')}.`,
      ),
    );
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.scenario',
      'no scenarios matched',
    );
  }
  const runOptions = buildRunJobOptions(options);
  const ctx = createRenderContext(options, commandFlags);
  if (
    reporter !== 'json' &&
    appliedConfigPath !== undefined &&
    (ctx.mode === 'verbose' || ctx.mode === 'debug')
  ) {
    writeStdout(`config: ${dynoDisplayPath(appliedConfigPath)}\n`);
  }
  // Rendering groups jobs by their source dyno; the label prefers the
  // authored dyno name and falls back to a readable path.
  const renderDynos: RunDynoGroup[] = dynoGroups
    .filter(({jobs: dynoJobs}) => dynoJobs.length > 0)
    .map(({entry, jobs: dynoJobs}) => ({
      ...(entry.ir.name === undefined ? {} : {name: entry.ir.name}),
      path: dynoDisplayPath(entry.filePath),
      jobs: dynoJobs,
    }));

  const execution =
    reporter === 'json'
      ? await runStatic({
          dynos: renderDynos,
          runOptions,
          ctx,
          writeStdout,
          reporter,
          configErrorCount: errors.length,
        })
      : shouldRenderLive(options, ctx)
        ? await runLive({dynos: renderDynos, runOptions, ctx, writeStdout})
        : await runStatic({
            dynos: renderDynos,
            runOptions,
            ctx,
            writeStdout,
            reporter,
            configErrorCount: errors.length,
          });

  const {results} = execution;
  const anyJobFailed = results.some((result) => !result.passed);
  const runFailed = anyJobFailed || errors.length > 0;

  if (commandFlags.saveRun === true) {
    await uploadRun({
      dynos: dynoGroups
        .filter(({jobs: dynoJobs}) => dynoJobs.length > 0)
        .map(({entry, jobs: dynoJobs}) => ({
          dynoPath: dynoDisplayPath(entry.filePath),
          name: entry.ir.name ?? null,
          target: dynoTarget(entry),
          jobs: dynoJobs,
        })),
      results,
      runFailed,
      inputPath: inputLabel,
      ...(options.env === undefined ? {} : {env: options.env}),
      writeStderr,
    });
  }

  return runFailed;
}

async function validateSaveRunAuth(input: {
  inputLabel: string;
  env: ExecuteCliOptions['env'];
  writeStderr: OutputWriter;
}): Promise<void> {
  const token = resolveAuthToken(
    input.env === undefined ? {} : {env: input.env},
  );
  if (token === null) {
    input.writeStderr(
      renderRunConfigErrorMessage(
        input.inputLabel,
        '--save-run requires a Dynobox token. Run `dynobox login` or set DYNOBOX_TOKEN.',
      ),
    );
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.auth',
      '--save-run requires a token',
    );
  }

  let lastResult: IdentityResult | null = null;
  for (let attempt = 0; attempt < AUTH_PREFLIGHT_ATTEMPTS; attempt += 1) {
    const result = await fetchAuthenticatedIdentity({
      apiUrl: resolveApiUrl(input.env),
      token,
    });
    if (result.status === 'authenticated') return;

    if (result.status === 'expired') {
      failSaveRunAuth(
        input,
        '--save-run token expired; run `dynobox login` again to re-authenticate.',
        '--save-run token expired',
      );
    }

    if (result.status === 'unauthorized') {
      failSaveRunAuth(
        input,
        '--save-run requires a valid Dynobox token. Run `dynobox login` or set a valid DYNOBOX_TOKEN.',
        '--save-run requires valid auth',
      );
    }

    lastResult = result;
    if (attempt < AUTH_PREFLIGHT_ATTEMPTS - 1) {
      await delayAuthPreflightRetry(attempt);
    }
  }

  failSaveRunAuth(
    input,
    `Could not verify Dynobox authentication after ${AUTH_PREFLIGHT_ATTEMPTS} attempts. Try --save-run again later.`,
    describeSaveRunVerificationFailure(lastResult),
  );
}

function delayAuthPreflightRetry(attempt: number): Promise<void> {
  const delayMs = AUTH_PREFLIGHT_RETRY_BASE_DELAY_MS * 2 ** attempt;
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function failSaveRunAuth(
  input: {inputLabel: string; writeStderr: OutputWriter},
  message: string,
  errorMessage: string,
): never {
  input.writeStderr(renderRunConfigErrorMessage(input.inputLabel, message));
  throw new CommanderError(configErrorExitCode, 'dynobox.auth', errorMessage);
}

function describeSaveRunVerificationFailure(
  result: IdentityResult | null,
): string {
  if (result?.status === 'api_error') {
    return `--save-run auth verification failed with HTTP ${result.httpStatus}`;
  }
  return '--save-run auth verification failed';
}

/** The dyno file path as authored/discovered, relative to the working dir. */
function dynoDisplayPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel === '' || rel.startsWith('..') ? filePath : rel;
}

/**
 * Resolve the dyno's target — the thing being tested. Prefers the authored
 * `target` field; falls back to the dyno file's parent directory name (e.g.
 * `skills/github-pr-agent/review.dyno.ts` -> `github-pr-agent`).
 */
function dynoTarget(entry: DynoCompileSuccess): string {
  if (entry.ir.target !== undefined) return entry.ir.target;
  const parent = basename(dirname(entry.filePath));
  return parent === '' || parent === '.' ? basename(entry.filePath) : parent;
}

async function discoverOrFail(
  configPath: string | undefined,
  resolvedInputPath: string,
  configFilePath: string | undefined,
  writeStderr: OutputWriter,
): Promise<DiscoverDynosResult> {
  try {
    return await discoverDynos(configPath, {
      ...(configFilePath === undefined ? {} : {configPath: configFilePath}),
    });
  } catch (error) {
    const label = configPath ?? resolvedInputPath;
    if (error instanceof DynoPathNotFoundError) {
      writeStderr(renderRunConfigErrorMessage(label, error.message));
    } else {
      const message = error instanceof Error ? error.message : String(error);
      writeStderr(renderRunConfigErrorMessage(label, message));
    }
    throw new CommanderError(
      configErrorExitCode,
      'dynobox.config',
      'discovery failed',
    );
  }
}

type RunPathInput = {
  dynos: readonly RunDynoGroup[];
  runOptions: RunJobOptions;
  ctx: RenderContext;
  writeStdout: OutputWriter;
  reporter?: ReturnType<typeof validateReporterFormat>;
  configErrorCount?: number;
};

type RunPathResult = {
  results: LocalRunnerResult[];
  elapsedMs: number;
};

/**
 * Static path: run every job to completion, then render the full output as
 * one batched string. Used in CI, with `--quiet`, or when the terminal
 * doesn't support live updates.
 */
async function runStatic(input: RunPathInput): Promise<RunPathResult> {
  const jobs = input.dynos.flatMap((dyno) => dyno.jobs);
  const execution = await runScenarioExecutions(input.dynos, (job) =>
    runJob(job, input.runOptions),
  );
  const {results, elapsedMs} = execution;
  const debugLogPaths = writeDebugLogsIfDebug(input.ctx, input.dynos, results);
  if (input.reporter === 'json') {
    input.writeStdout(
      renderJsonRunOutput({
        jobs,
        results,
        elapsedMs,
        configErrorCount: input.configErrorCount ?? 0,
        ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
      }),
    );
    return execution;
  }
  input.writeStdout(
    renderRunOutput({
      dynos: input.dynos,
      results,
      elapsedMs,
      ctx: input.ctx,
      ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
    }),
  );
  return execution;
}

/**
 * Live path: print a header, then stream grouped output — dyno and scenario
 * lines as groups begin, a spinner-driven row per harness group that advances
 * through phases as runner events arrive, and a grouped summary at the end.
 *
 * Passing groups in default mode collapse to a one-line grouped row;
 * failures and expanded modes keep their detail blocks.
 */
async function runLive(input: RunPathInput): Promise<RunPathResult> {
  const {dynos, runOptions, ctx, writeStdout} = input;
  const jobs = dynos.flatMap((dyno) => dyno.jobs);

  writeStdout(renderRunHeader(dynos, ctx));
  const multiHarness = uniqueHarnessLabels(jobs).length > 1;
  const labelWidth = harnessLabelColumnWidth(jobs);
  const live = createLiveDashboard(writeStdout, ctx.color, SPINNER_FRAMES[0]);
  const spinnerEnabled = ctx.color && !ctx.usePlainSymbols;
  const spinner = spinnerEnabled
    ? createSpinner((frame) => {
        live.tick(frame);
      })
    : undefined;
  const expanded = ctx.mode === 'verbose' || ctx.mode === 'debug';
  const stateByJob = new Map<LocalRunnerJob, LiveJobState>();
  const laneIndexByJob = new Map<LocalRunnerJob, number>();
  const completedByLane = new Map<
    number,
    Array<{job: LocalRunnerJob; result: LocalRunnerResult}>
  >();
  let currentDyno: RunDynoGroup | undefined;

  const rowOptionsFor = (job: LocalRunnerJob): RowLabelOptions =>
    multiHarness
      ? {
          harnessLabel: uniqueHarnessLabels([job])[0]!,
          harnessLabelWidth: labelWidth,
        }
      : {};

  const executeJob = (job: LocalRunnerJob): Promise<LocalRunnerResult> =>
    runJob(job, {
      ...runOptions,
      onProgress: (event) => {
        const state = stateByJob.get(job);
        const laneIndex = laneIndexByJob.get(job);
        if (state === undefined || laneIndex === undefined) return;
        live.emit(laneIndex, renderLiveProgressEvent(event, state, ctx));
      },
    });

  try {
    spinner?.start();
    const execution = await runScenarioExecutions(dynos, executeJob, {
      scenarioStarted: (scenario) => {
        if (scenario.dyno !== currentDyno) {
          if (currentDyno !== undefined) writeStdout('\n');
          currentDyno = scenario.dyno;
          writeStdout(
            `${renderDynoLine(scenario.dyno.name ?? scenario.dyno.path, ctx)}\n`,
          );
        }
        writeStdout(`${renderScenarioLine(scenario.name, ctx)}\n`);
        stateByJob.clear();
        laneIndexByJob.clear();
        completedByLane.clear();
        scenario.harnessLanes.forEach((lane, laneIndex) => {
          completedByLane.set(laneIndex, []);
          for (const entry of lane.jobs) {
            laneIndexByJob.set(entry.job, laneIndex);
          }
        });
        live.start(
          scenario.harnessLanes.map((lane) => ({
            headline: renderRunningGroupRow(
              ctx,
              rowOptionsFor(lane.jobs[0]!.job),
            ),
          })),
        );
      },
      jobStarted: (entry, scenario) => {
        stateByJob.set(entry.job, createLiveJobState());
        const laneIndex = laneIndexByJob.get(entry.job);
        if (laneIndex === undefined) return;
        const iterationCount = scenario.harnessLanes[laneIndex]!.jobs.length;
        live.setHeadline(
          laneIndex,
          renderRunningGroupRow(ctx, {
            ...rowOptionsFor(entry.job),
            ...(iterationCount === 1
              ? {}
              : {iteration: entry.job.iteration, iterationCount}),
          }),
          true,
        );
      },
      jobCompleted: (entry, result) => {
        const laneIndex = laneIndexByJob.get(entry.job);
        if (laneIndex === undefined) return;
        const entries = completedByLane.get(laneIndex)!;
        entries.push({job: entry.job, result});
        live.setHeadline(
          laneIndex,
          renderHarnessGroupRow(entries, ctx, rowOptionsFor(entry.job)),
        );
      },
      scenarioCompleted: (scenario, scenarioResults) => {
        live.clear();
        writeLiveScenarioCompletion(
          scenario,
          scenarioResults,
          ctx,
          writeStdout,
          multiHarness,
          labelWidth,
          expanded,
        );
      },
    });
    writeStdout(renderRunSummary(execution.results, ctx, execution.elapsedMs));
    return execution;
  } finally {
    spinner?.stop();
    live.clear();
  }
}

function createLiveJobState(): LiveJobState {
  return {
    setupCommandCount: 0,
    fixturesCount: 0,
    toolCount: 0,
    assertionCount: 0,
    phaseStartedAtMs: Date.now(),
  };
}

function writeLiveScenarioCompletion(
  scenario: ScenarioExecution,
  scenarioResults: readonly LocalRunnerResult[],
  ctx: RenderContext,
  writeStdout: OutputWriter,
  multiHarness: boolean,
  labelWidth: number,
  expanded: boolean,
): void {
  const resultByJob = new Map(
    scenario.jobs.map(
      (entry, index) => [entry.job, scenarioResults[index]!] as const,
    ),
  );
  const groupedScenario = groupJobs(scenario.jobs.map((entry) => entry.job))[0];
  if (groupedScenario === undefined) return;

  for (const group of groupedScenario.harnessGroups) {
    const entries = group.jobs.map((job) => ({
      job,
      result: resultByJob.get(job)!,
    }));
    const rowOptions: RowLabelOptions = multiHarness
      ? {harnessLabel: group.label, harnessLabelWidth: labelWidth}
      : {};
    writeStdout(`${renderHarnessGroupRow(entries, ctx, rowOptions)}\n`);
    const assertionById = assertionByIdForJobs(group.jobs);

    if (!expanded) {
      writeStdout(
        entries.length === 1
          ? !entries[0]!.result.passed || entries[0]!.result.warnings.length > 0
            ? renderSingleJobFailureDetails(
                entries[0]!.result,
                assertionById,
                ctx,
              )
            : ''
          : renderIterationDetailLines(entries, assertionById, ctx),
      );
      continue;
    }

    for (const entry of entries) {
      if (entries.length > 1) {
        writeStdout(`${renderIterationResultLine(entry, ctx)}\n`);
      }
      const debugLogPaths = maybeWriteDebugLogs(ctx, entry.result);
      writeStdout(
        renderJobDetails(entry.result, assertionById, ctx, {
          configuredCliMockNames: Object.keys(entry.job.scenario.cliMocks),
          ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
        }),
      );
    }
  }
}

function validateOverrides(
  rawHarnesses: readonly string[] | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    renderRunConfigErrorMessage,
    () => validateHarnessOverrides(rawHarnesses),
  );
}

function validatePermissionMode(
  rawPermissionMode: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    renderRunConfigErrorMessage,
    () => validatePermissionModeOverride(rawPermissionMode),
  );
}

function validateModels(
  rawModels: readonly string[] | undefined,
  harnesses: ReturnType<typeof validateHarnessOverrides>,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    renderRunConfigErrorMessage,
    () => validateModelOverrides(rawModels, harnesses),
  );
}

function validateReporter(
  rawReporter: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    renderRunConfigErrorMessage,
    () => validateReporterFormat(rawReporter),
  );
}

function validateIterationCount(
  rawIterations: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  return reportConfigError(
    inputLabel,
    writeStderr,
    renderRunConfigErrorMessage,
    () => validateIterations(rawIterations),
  );
}

function buildJobOptions(
  harnesses: ReturnType<typeof validateHarnessOverrides>,
  models: ReturnType<typeof validateModelOverrides>,
  permissionMode: ReturnType<typeof validatePermissionModeOverride>,
  scenarioPatterns: ReturnType<typeof validateScenarioFilters>,
  iterations: ReturnType<typeof validateIterations>,
): Parameters<typeof buildLocalRunnerJobs>[1] {
  const selectedHarnesses =
    harnesses === undefined
      ? undefined
      : models === undefined
        ? unique(harnesses).map((id) => ({id}))
        : uniqueHarnessSelections(
            harnesses.map((id, index) => ({id, model: models[index]!})),
          );
  return {
    ...(selectedHarnesses === undefined ? {} : {harnesses: selectedHarnesses}),
    ...(permissionMode === undefined ? {} : {permissionMode}),
    ...(scenarioPatterns === undefined ? {} : {scenarioPatterns}),
    iterations,
  };
}

function uniqueHarnessSelections<T extends {id: string; model?: string}>(
  selections: readonly T[],
): T[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = `${selection.id}\0${selection.model ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * If we're in debug mode, write each result's harness debug logs to its
 * work directory and return a `Map<job, paths>` for the renderer.
 */
function writeDebugLogsIfDebug(
  ctx: RenderContext,
  dynos: readonly RunDynoGroup[],
  results: readonly LocalRunnerResult[],
): Map<LocalRunnerJob, DebugLogPaths> | undefined {
  if (ctx.mode !== 'debug') return undefined;
  const jobs = dynos.flatMap((dyno) => dyno.jobs);
  const map = new Map<LocalRunnerJob, DebugLogPaths>();
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]!;
    const result = results[index];
    if (result === undefined) continue;
    const paths = maybeWriteDebugLogs(ctx, result);
    if (paths !== undefined) map.set(job, paths);
  }
  return map.size === 0 ? undefined : map;
}

function maybeWriteDebugLogs(
  ctx: RenderContext,
  result: LocalRunnerResult,
): DebugLogPaths | undefined {
  if (ctx.mode !== 'debug') return undefined;
  const paths = writeDebugLogs(result);
  return hasDebugLogPaths(paths) ? paths : undefined;
}
