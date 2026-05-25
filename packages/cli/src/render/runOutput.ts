/**
 * Static-mode (non-live) run output orchestrator. Composes header + per-job
 * headline (and optionally job details) + summary into a single string.
 *
 * The live path doesn't go through here — it streams to a `LiveWriter` in
 * `program/runCommand.ts`.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {assertionByIdForJobs} from '../jobs.js';
import {createRenderContext, type RenderContext} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';
import {renderRunHeader} from './header.js';
import {renderHeadline} from './headline.js';
import {renderJobDetails} from './jobDetails.js';
import {renderPassRateMatrix} from './matrix.js';
import {renderQuietRun} from './quiet.js';
import {renderRunSummary} from './summary.js';

export type RenderRunOutputInput = {
  configPath: string;
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  ctx?: RenderContext;
  /**
   * Optional map of jobId → debug log paths, populated by the runner
   * when running in `debug` mode. Used to print the log path in debug
   * details without coupling renderers to the filesystem.
   */
  debugLogPaths?: Map<string, DebugLogPaths>;
};

export function renderRunOutput(input: RenderRunOutputInput): string {
  const ctx = input.ctx ?? createRenderContext();
  if (ctx.mode === 'quiet') {
    return renderQuietRun(input.jobs, input.results, ctx);
  }

  const assertionById = assertionByIdForJobs(input.jobs);
  const lines: string[] = [renderRunHeader(input.configPath, input.jobs, ctx)];
  const expandAll = ctx.mode === 'verbose' || ctx.mode === 'debug';
  const matrixRun = input.jobs.some((job) => job.iteration > 0);
  if (matrixRun)
    lines.push(renderPassRateMatrix(input.jobs, input.results, ctx));

  for (const [index, job] of input.jobs.entries()) {
    const result = input.results[index];
    if (result === undefined) continue;
    if (matrixRun && !expandAll && result.passed) continue;

    const expand = expandAll || !result.passed || result.warnings.length > 0;
    const status: 'pass' | 'fail' = result.passed ? 'pass' : 'fail';
    const headline = renderHeadline(
      job,
      ctx,
      status,
      expand ? undefined : result.timing.totalMs,
    );
    lines.push(`${headline}\n`);
    if (expand) {
      const debugLogPaths = input.debugLogPaths?.get(job.id);
      lines.push(
        renderJobDetails(
          result,
          assertionById,
          ctx,
          debugLogPaths === undefined ? {} : {debugLogPaths},
        ),
      );
    }
  }

  lines.push(renderRunSummary(input.jobs, input.results, ctx));

  return lines.join('');
}
