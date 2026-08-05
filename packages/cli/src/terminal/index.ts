/**
 * Terminal presentation primitives — ANSI codes, formatters, layout helpers,
 * and the `RenderContext` that ties them together. No domain knowledge of
 * jobs, scenarios, or assertions lives here.
 */

export {BOLD, RESET, visibleLength} from './ansi.js';
export {
  escapeTerminalText,
  formatCount,
  formatDuration,
  formatLiveDuration,
} from './format.js';
export {DEFAULT_WIDTH, leftRight, separator, truncate} from './layout.js';
export {
  createRenderContext,
  type RenderContext,
  type RunOutputMode,
} from './renderContext.js';
export {colorStatus, dim, style, symbol} from './style.js';
