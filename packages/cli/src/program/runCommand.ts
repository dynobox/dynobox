/**
 * Action handler for `dynobox run [path]`.
 *
 * Top-level flow:
 *   1. Validate `--harness` overrides, resolve the discovery target.
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

import {resolve} from 'node:path';

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
import {compileDynos, type DynoCompileSuccess} from './compileDynos.js';
import {
  discoverDynos,
  DynoTargetNotFoundError,
  NoDynosFoundError,
} from './discoverDynos.js';
import {shouldRenderLive} from './environment.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {
  buildRunJobOptions,
  validateHarnessOverrides,
  validatePermissionModeOverride,
} from './options.js';

export type RunCommandFlags = {
  harness?: string[];
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  permissionMode?: string;
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
  const targetLabel = configPath ?? '.';
  const resolvedTarget = resolve(targetLabel);

  const overrideHarnesses = validateOverrides(
    commandFlags.harness,
    targetLabel,
    writeStderr,
  );
  const permissionMode = validatePermissionMode(
    commandFlags.permissionMode,
    targetLabel,
    writeStderr,
  );

  const filePaths = await discoverOrFail(
    configPath,
    resolvedTarget,
    writeStderr,
  );
  const {compiled, errors} = await compileDynos(filePaths);

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

  const jobs = compiled.flatMap((entry) =>
    buildLocalRunnerJobs(
      entry.ir,
      buildJobOptions(overrideHarnesses, permissionMode),
    ),
  );
  const runOptions = buildRunJobOptions(options);
  const ctx = createRenderContext(options, commandFlags);
  const headerLabel = renderHeaderLabel(targetLabel, compiled);

  const results = shouldRenderLive(options, ctx)
    ? await runLive({headerLabel, jobs, runOptions, ctx, writeStdout})
    : await runStatic({headerLabel, jobs, runOptions, ctx, writeStdout});

  const anyJobFailed = results.some((result) => !result.passed);
  return anyJobFailed || errors.length > 0;
}

/**
 * Build a short label for the run header that captures what the user
 * asked to run. When discovery found multiple files, append the count
 * so a reader knows the run spans more than a single config.
 */
function renderHeaderLabel(
  targetLabel: string,
  compiled: readonly DynoCompileSuccess[],
): string {
  if (compiled.length === 1) {
    const only = compiled[0];
    if (only === undefined) return targetLabel;
    return only.filePath;
  }
  return `${targetLabel}  (${compiled.length} dyno files)`;
}

async function discoverOrFail(
  configPath: string | undefined,
  resolvedTarget: string,
  writeStderr: OutputWriter,
): Promise<readonly string[]> {
  try {
    return await discoverDynos(configPath);
  } catch (error) {
    const label = configPath ?? resolvedTarget;
    if (
      error instanceof DynoTargetNotFoundError ||
      error instanceof NoDynosFoundError
    ) {
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
      const collapse = result.passed && !expanded;
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
  targetLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateHarnessOverrides(rawHarnesses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(targetLabel, message));
    throw error;
  }
}

function validatePermissionMode(
  rawPermissionMode: string | undefined,
  targetLabel: string,
  writeStderr: OutputWriter,
) {
  try {
    return validatePermissionModeOverride(rawPermissionMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(targetLabel, message));
    throw error;
  }
}

function buildJobOptions(
  harnesses: ReturnType<typeof validateHarnessOverrides>,
  permissionMode: ReturnType<typeof validatePermissionModeOverride>,
): Parameters<typeof buildLocalRunnerJobs>[1] {
  return {
    ...(harnesses === undefined ? {} : {harnesses}),
    ...(permissionMode === undefined ? {} : {permissionMode}),
  };
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
