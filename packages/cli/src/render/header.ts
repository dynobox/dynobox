/**
 * Header banner printed at the top of every run.
 */

import type {LocalRunnerJob} from '@dynobox/runner-local';

import {renderPlan} from '../jobs.js';
import {
  createRenderContext,
  dim,
  formatCount,
  leftRight,
  type RenderContext,
  style,
} from '../terminal/index.js';
import {readPackageVersion} from '../util/version.js';

export function renderRunHeader(
  configPath: string,
  jobs: readonly LocalRunnerJob[],
  ctx: RenderContext = createRenderContext(),
): string {
  const plan = renderPlan(jobs);
  const jobCount = formatCount(jobs.length, 'job');
  return `  ${style(ctx, 'dynobox', 'brand')}  ${readPackageVersion()}

  config   ${dim(ctx, configPath)}
  ${leftRight(`plan     ${plan}`, jobCount, ctx.width)}

`;
}
