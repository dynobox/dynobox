/**
 * Static-mode (non-live) run output orchestrator. Composes header + grouped
 * run body + summary into a single string.
 *
 * The live path doesn't go through here — it streams to a `LiveWriter` in
 * `program/runCommand.ts` using the same grouped row renderers.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {createRenderContext, type RenderContext} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';
import {renderGroupedRun} from './groupedRun.js';
import {renderRunHeader} from './header.js';
import type {RunDynoGroup} from './plan.js';
import {renderQuietRun} from './quiet.js';
import {renderRunSummary} from './summary.js';

export type RenderRunOutputInput = {
  /** Jobs grouped by the dyno they were discovered from, in execution order. */
  dynos: readonly RunDynoGroup[];
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
    return renderQuietRun(input.dynos, input.results, ctx);
  }

  const jobs = input.dynos.flatMap((dyno) => dyno.jobs);
  return [
    renderRunHeader(input.dynos, ctx),
    renderGroupedRun({
      dynos: input.dynos,
      results: input.results,
      ctx,
      ...(input.debugLogPaths === undefined
        ? {}
        : {debugLogPaths: input.debugLogPaths}),
    }),
    renderRunSummary(jobs, input.results, ctx),
  ].join('');
}
