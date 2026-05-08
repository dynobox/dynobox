/**
 * Detect whether the current process should produce live, ANSI-colored
 * output (as opposed to plain CI-friendly batched output).
 */

import type {RunOutputMode} from '../terminal/index.js';
import type {ExecuteCliOptions} from './execute.js';

/**
 * Live output is appropriate when:
 *   - stdout is a TTY (we can move the cursor, redraw lines)
 *   - we're not in CI (CI logs typically capture stdout line-by-line)
 *   - the user hasn't opted out of color via `NO_COLOR`
 *   - the terminal isn't `TERM=dumb` (no escape support)
 */
export function shouldUseLiveTerminalOutput(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI !== undefined) return false;
  if ('NO_COLOR' in process.env) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

/**
 * Final gate before driving the live writer. We only render live in live
 * mode AND when the output mode is interactive (`quiet` always falls back
 * to the static one-liner-per-job path).
 */
export function shouldRenderLive(
  options: Pick<ExecuteCliOptions, 'live'>,
  ctx: {mode: RunOutputMode},
): boolean {
  return options.live === true && ctx.mode !== 'quiet';
}
