/**
 * Action handler for `dynobox run <config>`.
 *
 * Top-level flow:
 *   1. Validate `--harness` overrides, load + compile the config.
 *   2. Build the job matrix.
 *   3. Choose the live (interactive) or static (batched) output path.
 *   4. Execute jobs, write transcript logs in debug mode, render output.
 *   5. Return whether any job failed.
 *
 * Splitting `runLive` and `runStatic` keeps each path linear and easy to
 * read; both share the same job-iteration shape.
 */

import {
  type LocalRunnerJob,
  type LocalRunnerResult,
  runJob,
  type RunJobOptions,
} from '@dynobox/runner-local';
import {compile, type Ir, resolveConfigModule} from '@dynobox/sdk';
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
import {writeTranscriptLog} from '../util/transcript.js';
import {loadConfigModule, normalizeLoadedModule} from './configLoader.js';
import {shouldRenderLive} from './environment.js';
import type {ExecuteCliOptions, OutputWriter} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';
import {buildRunJobOptions, validateHarnessOverrides} from './options.js';

export type RunCommandFlags = {
  harness?: string[];
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
};

export type RunCommandActionInput = {
  configPath: string;
  commandFlags: RunCommandFlags;
  options: ExecuteCliOptions;
  writeStdout: OutputWriter;
  writeStderr: OutputWriter;
};

/**
 * Run the `run` subcommand end-to-end.
 *
 * @returns `true` if any job failed (caller should set the run-failure
 * exit code), `false` if every job passed.
 */
export async function runCommandAction(
  input: RunCommandActionInput,
): Promise<boolean> {
  const {configPath, commandFlags, options, writeStdout, writeStderr} = input;

  const overrideHarnesses = validateOverrides(
    commandFlags.harness,
    configPath,
    writeStderr,
  );
  const ir = await compileConfig(configPath, writeStderr);
  const jobs = buildLocalRunnerJobs(
    ir,
    overrideHarnesses === undefined ? {} : {harnesses: overrideHarnesses},
  );
  const runOptions = buildRunJobOptions(options);
  const ctx = createRenderContext(options, commandFlags);

  const results = shouldRenderLive(options, ctx)
    ? await runLive({configPath, jobs, runOptions, ctx, writeStdout})
    : await runStatic({configPath, jobs, runOptions, ctx, writeStdout});

  return results.some((result) => !result.passed);
}

type RunPathInput = {
  configPath: string;
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
  const transcriptLogPaths = writeTranscriptLogsIfDebug(input.ctx, results);
  input.writeStdout(
    renderRunOutput({
      configPath: input.configPath,
      jobs: input.jobs,
      results,
      ctx: input.ctx,
      ...(transcriptLogPaths === undefined ? {} : {transcriptLogPaths}),
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
  const {configPath, jobs, runOptions, ctx, writeStdout} = input;

  writeStdout(renderRunHeader(configPath, jobs, ctx));
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
        const transcriptLogPath = maybeWriteTranscriptLog(ctx, result);
        writeStdout(
          renderLiveJobCompletion(
            result,
            assertionById,
            ctx,
            transcriptLogPath === undefined ? {} : {transcriptLogPath},
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
  configPath: string,
  writeStderr: OutputWriter,
) {
  try {
    return validateHarnessOverrides(rawHarnesses);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(configPath, message));
    throw error;
  }
}

/**
 * Load and compile the config. On failure, write the standard config-error
 * message and throw `CommanderError(configErrorExitCode)` so the top-level
 * executor returns the documented exit code.
 */
async function compileConfig(
  configPath: string,
  writeStderr: OutputWriter,
): Promise<Ir> {
  try {
    const moduleExport = await loadConfigModule(configPath);
    const config = resolveConfigModule(normalizeLoadedModule(moduleExport));
    return compile(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(renderRunConfigErrorMessage(configPath, message));
    throw new CommanderError(configErrorExitCode, 'dynobox.config', message);
  }
}

/**
 * If we're in debug mode, write each result's harness transcript to its
 * work directory and return a `Map<jobId, path>` for the renderer.
 */
function writeTranscriptLogsIfDebug(
  ctx: RenderContext,
  results: readonly LocalRunnerResult[],
): Map<string, string> | undefined {
  if (ctx.mode !== 'debug') return undefined;
  const map = new Map<string, string>();
  for (const result of results) {
    const path = maybeWriteTranscriptLog(ctx, result);
    if (path !== undefined) map.set(result.jobId, path);
  }
  return map.size === 0 ? undefined : map;
}

function maybeWriteTranscriptLog(
  ctx: RenderContext,
  result: LocalRunnerResult,
): string | undefined {
  if (ctx.mode !== 'debug') return undefined;
  const transcript = result.harnessResult?.transcript;
  if (transcript === undefined || transcript.length === 0) return undefined;
  return writeTranscriptLog(result.workDir, transcript);
}
