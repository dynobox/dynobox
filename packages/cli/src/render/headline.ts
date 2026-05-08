/**
 * Per-job headline row: status icon + scenario name on the left,
 * harness/iteration (and optional duration) on the right.
 *
 * Used by both the static and live output paths.
 */

import type {LocalRunnerJob} from '@dynobox/runner-local';

import {formatJobHarness} from '../jobs.js';
import {
  colorStatus,
  formatDuration,
  leftRight,
  type RenderContext,
  symbol,
} from '../terminal/index.js';

export type HeadlineStatus = 'pass' | 'fail' | 'running';

export function renderHeadline(
  job: LocalRunnerJob,
  ctx: RenderContext,
  status: HeadlineStatus,
  durationMs: number | undefined,
): string {
  const icon = colorStatus(
    ctx,
    symbol(ctx, status),
    status === 'running' ? 'plain' : status,
  );
  const title = `${icon}  ${job.scenario.name}`;
  const meta = `${formatJobHarness(job)}  iter ${job.iteration + 1}`;
  const right =
    durationMs === undefined ? meta : `${meta}   ${formatDuration(durationMs)}`;
  return `  ${leftRight(title, right, ctx.width)}`;
}
