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
  createLiveWriter,
  createSpinner,
  type LiveJobState,
  renderLiveJobCompletion,
  renderLiveProgressEvent,
  SPINNER_FRAMES,
} from '../live/index.js';
import {
  renderHeadline,
  renderJsonRunOutput,
  renderPassRateMatrix,
  renderRunConfigErrorMessage,
  renderRunHeader,
  renderRunOutput,
  renderRunSummary,
} from '../render/index.js';
import {createRenderContext, type RenderContext} from '../terminal/index.js';
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
  buildRunJobOptions,
  validateHarnessOverrides,
  validateIterations,
  validateModelOverrides,
  validatePermissionModeOverride,
  validateReporterFormat,
  validateScenarioFilters,
} from './options.js';
import {uploadRun} from './uploadRun.js';

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

  // Fail fast: when --save-run is requested but no token is available, error
  // before running any scenarios instead of running the whole suite and only
  // warning at the end that the run could not be saved.
  if (commandFlags.saveRun === true) {
    const token = resolveAuthToken(
      options.env === undefined ? {} : {env: options.env},
    );
    if (token === null) {
      writeStderr(
        renderRunConfigErrorMessage(
          inputLabel,
          '--save-run requires a Dynobox token. Run `dynobox login` or set DYNOBOX_TOKEN.',
        ),
      );
      throw new CommanderError(
        configErrorExitCode,
        'dynobox.auth',
        '--save-run requires a token',
      );
    }
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
  const headerLabel = renderHeaderLabel(inputLabel, compiled);

  const results =
    reporter === 'json'
      ? await runStatic({
          headerLabel,
          jobs,
          runOptions,
          ctx,
          writeStdout,
          reporter,
          configErrorCount: errors.length,
        })
      : shouldRenderLive(options, ctx)
        ? await runLive({headerLabel, jobs, runOptions, ctx, writeStdout})
        : await runStatic({
            headerLabel,
            jobs,
            runOptions,
            ctx,
            writeStdout,
            reporter,
            configErrorCount: errors.length,
          });

  const anyJobFailed = results.some((result) => !result.passed);
  const runFailed = anyJobFailed || errors.length > 0;

  if (commandFlags.saveRun === true) {
    await uploadRun({
      dynos: dynoGroups.map(({entry, jobs: dynoJobs}) => ({
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

/** The dyno file path as authored/discovered, relative to the working dir. */
function dynoDisplayPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel === '' || rel.startsWith('..') ? filePath : rel;
}

/**
 * Resolve the dyno's target — the thing being tested. Prefers the authored
 * `target` field; falls back to the dyno file's parent directory name (e.g.
 * `examples/github-pr-agent/review.dyno.ts` -> `github-pr-agent`).
 */
function dynoTarget(entry: DynoCompileSuccess): string {
  if (entry.ir.target !== undefined) return entry.ir.target;
  const parent = basename(dirname(entry.filePath));
  return parent === '' || parent === '.' ? basename(entry.filePath) : parent;
}

/**
 * Build a short label for the run header that captures what the user
 * asked to run. When discovery found multiple files, append the count
 * so a reader knows the run spans more than a single config.
 */
function renderHeaderLabel(
  inputLabel: string,
  compiled: readonly DynoCompileSuccess[],
): string {
  if (compiled.length === 1) {
    const only = compiled[0];
    if (only === undefined) return inputLabel;
    return only.filePath;
  }
  return `${inputLabel}  (${compiled.length} dyno files)`;
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
  headerLabel: string;
  jobs: readonly LocalRunnerJob[];
  runOptions: RunJobOptions;
  ctx: RenderContext;
  writeStdout: OutputWriter;
  reporter?: ReturnType<typeof validateReporterFormat>;
  configErrorCount?: number;
};

/**
 * Static path: run every job to completion, then render the full output as
 * one batched string. Used in CI, with `--quiet`, or when the terminal
 * doesn't support live updates.
 */
async function runStatic(input: RunPathInput): Promise<LocalRunnerResult[]> {
  const results: LocalRunnerResult[] = [];
  for (const job of input.jobs) {
    results.push(await runJob(job, input.runOptions));
  }
  const debugLogPaths = writeDebugLogsIfDebug(input.ctx, results);
  if (input.reporter === 'json') {
    input.writeStdout(
      renderJsonRunOutput({
        jobs: input.jobs,
        results,
        configErrorCount: input.configErrorCount ?? 0,
        ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
      }),
    );
    return results;
  }
  input.writeStdout(
    renderRunOutput({
      configPath: input.headerLabel,
      jobs: input.jobs,
      results,
      ctx: input.ctx,
      ...(debugLogPaths === undefined ? {} : {debugLogPaths}),
    }),
  );
  return results;
}

/**
 * Live path: print a header, then for each job stream a spinner-driven row
 * that advances through phases as runner events arrive. Passing jobs in
 * default mode collapse to a one-liner; everything else stays expanded.
 */
async function runLive(input: RunPathInput): Promise<LocalRunnerResult[]> {
  const {headerLabel, jobs, runOptions, ctx, writeStdout} = input;

  writeStdout(renderRunHeader(headerLabel, jobs, ctx));
  const assertionById = assertionByIdForJobs(jobs);
  const live = createLiveWriter(writeStdout, ctx.color, SPINNER_FRAMES[0]);
  const spinnerEnabled = ctx.color && !ctx.usePlainSymbols;
  const spinner = spinnerEnabled
    ? createSpinner((frame) => {
        live.tick(frame);
      })
    : undefined;
  const expanded = ctx.mode === 'verbose' || ctx.mode === 'debug';
  const results: LocalRunnerResult[] = [];

  try {
    spinner?.start();
    for (const job of jobs) {
      const state: LiveJobState = {
        setupCommandCount: 0,
        fixturesCount: 0,
        toolCount: 0,
        assertionCount: 0,
        phaseStartedAtMs: Date.now(),
      };
      live.beginJob(renderHeadline(job, ctx, 'running', undefined));

      const result = await runJob(job, {
        ...runOptions,
        onProgress: (event) => {
          live.emit(renderLiveProgressEvent(event, state, ctx));
        },
      });
      results.push(result);
      live.flush();

      const finalStatus: 'pass' | 'fail' = result.passed ? 'pass' : 'fail';
      const collapse =
        result.passed && result.warnings.length === 0 && !expanded;
      const finalHeadline = renderHeadline(
        job,
        ctx,
        finalStatus,
        collapse ? result.timing.totalMs : undefined,
      );

      if (collapse) {
        live.collapseToHeadline(finalHeadline);
      } else {
        live.rewriteHeadline(finalHeadline);
        const debugLogPaths = maybeWriteDebugLogs(ctx, result);
        writeStdout(
          renderLiveJobCompletion(
            result,
            assertionById,
            ctx,
            debugLogPaths === undefined ? {} : {debugLogPaths},
          ),
        );
      }
    }
  } finally {
    spinner?.stop();
  }

  if (jobs.some((job) => job.iteration > 0)) {
    writeStdout(renderPassRateMatrix(jobs, results, ctx));
  }
  writeStdout(renderRunSummary(jobs, results, ctx));
  return results;
}

/**
 * Run `validateHarnessOverrides`, but render the standard config-error
 * stderr block if it throws so users see what went wrong before the
 * non-zero exit code propagates.
 */
function validateOverrides(
  rawHarnesses: readonly string[] | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateHarnessOverrides(rawHarnesses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(inputLabel, message));
    throw error;
  }
}

function validatePermissionMode(
  rawPermissionMode: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validatePermissionModeOverride(rawPermissionMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(inputLabel, message));
    throw error;
  }
}

function validateModels(
  rawModels: readonly string[] | undefined,
  harnesses: ReturnType<typeof validateHarnessOverrides>,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateModelOverrides(rawModels, harnesses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(inputLabel, message));
    throw error;
  }
}

function validateReporter(
  rawReporter: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateReporterFormat(rawReporter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(inputLabel, message));
    throw error;
  }
}

function validateIterationCount(
  rawIterations: string | undefined,
  inputLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateIterations(rawIterations);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(inputLabel, message));
    throw error;
  }
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
 * work directory and return a `Map<jobId, paths>` for the renderer.
 */
function writeDebugLogsIfDebug(
  ctx: RenderContext,
  results: readonly LocalRunnerResult[],
): Map<string, DebugLogPaths> | undefined {
  if (ctx.mode !== 'debug') return undefined;
  const map = new Map<string, DebugLogPaths>();
  for (const result of results) {
    const paths = maybeWriteDebugLogs(ctx, result);
    if (paths !== undefined) map.set(result.jobId, paths);
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
