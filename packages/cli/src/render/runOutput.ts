/**
 * Static-mode (non-live) run output orchestrator. Composes header + grouped
 * run body + summary into a single string.
 *
 * The live path doesn't go through here — it streams to a `LiveWriter` in
 * `program/runCommand.ts` using the same grouped row renderers.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

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
  /** Wall-clock time for the complete run. */
  elapsedMs?: number;
  ctx?: RenderContext;
  /**
   * Optional map of job → debug log paths, populated by the runner when
   * running in `debug` mode. Used to print the log path in debug details
   * without coupling renderers to the filesystem.
   */
  debugLogPaths?: Map<LocalRunnerJob, DebugLogPaths>;
};

export function renderRunOutput(input: RenderRunOutputInput): string {
  const ctx = input.ctx ?? createRenderContext();
  if (ctx.mode === 'quiet') {
    return renderQuietRun(input.dynos, input.results, ctx, input.elapsedMs);
  }

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
    renderRunSummary(input.results, ctx, input.elapsedMs),
  ].join('');
}
