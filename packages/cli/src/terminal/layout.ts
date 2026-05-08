/**
 * Layout helpers: width-aware joins and clipping. ANSI-escape-aware via
 * `visibleLength` from {@link ./ansi.ts}.
 */

import {visibleLength} from './ansi.js';
import type {RenderContext} from './renderContext.js';
import {style} from './style.js';

/** Default render width when no terminal width is supplied. */
export const DEFAULT_WIDTH = 72;

/**
 * Render a horizontal separator the width of the context, dimmed.
 */
export function separator(ctx: RenderContext): string {
  return style(ctx, '─'.repeat(Math.max(20, ctx.width - 2)), 'dim');
}

/**
 * Place `left` and `right` on a single line, padding the gap so that the
 * total visible width matches `width`. Falls back to a single space if there
 * isn't room.
 */
export function leftRight(left: string, right: string, width: number): string {
  if (right.length === 0) return left;
  const gap = width - visibleLength(left) - visibleLength(right);
  return gap <= 1 ? `${left} ${right}` : `${left}${' '.repeat(gap)}${right}`;
}

/**
 * Truncate `value` to `maxLength` characters, replacing the tail with `...`.
 *
 * Operates on raw string length — callers should strip or avoid ANSI escapes
 * if they want visible-width truncation.
 */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
