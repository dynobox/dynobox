/**
 * Header banner printed at the top of every run: the brand/version line and
 * a one-line discovery summary of what the run will execute.
 */

import {
  createRenderContext,
  dim,
  type RenderContext,
  style,
} from '../terminal/index.js';
import {readPackageVersion} from '../util/version.js';
import {renderDiscoverySummary, type RunDynoGroup} from './plan.js';

const HEADER_INDENT = '  ';
const DISCOVERED_PREFIX = 'discovered ';

export function renderRunHeader(
  dynos: readonly RunDynoGroup[],
  ctx: RenderContext = createRenderContext(),
): string {
  const summaryWidth =
    ctx.width - HEADER_INDENT.length - DISCOVERED_PREFIX.length;
  const summary = renderDiscoverySummary(dynos, summaryWidth);
  return `${HEADER_INDENT}${style(ctx, '■ dynobox', 'brand')}  ${readPackageVersion()}
${HEADER_INDENT}${dim(ctx, `${DISCOVERED_PREFIX}${summary}`)}

`;
}
