/**
 * Layout helpers: width-aware joins and clipping. ANSI-escape-aware via
 * `visibleLength` from {@link ./ansi.ts}.
 */

import {RESET, visibleLength} from './ansi.js';
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
 * total visible width matches `width`. Truncates overflowing content while
 * preserving ANSI styling.
 */
export function leftRight(left: string, right: string, width: number): string {
  if (right.length === 0) return truncateVisible(left, width);
  const rightWidth = visibleLength(right);
  if (rightWidth >= width) return truncateVisible(right, width);
  const gap = width - visibleLength(left) - rightWidth;
  if (gap >= 1) return `${left}${' '.repeat(gap)}${right}`;
  return `${truncateVisible(left, width - rightWidth - 1)} ${right}`;
}

const ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_AT_START = new RegExp(`^${ESCAPE}\\[[0-9;]*m`);

function truncateVisible(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (visibleLength(value) <= maxLength) return value;

  const suffix = '...'.slice(0, maxLength);
  const contentLength = maxLength - suffix.length;
  let result = '';
  let index = 0;
  let length = 0;
  while (index < value.length && length < contentLength) {
    const escape = value.slice(index).match(ANSI_ESCAPE_AT_START)?.[0];
    if (escape !== undefined) {
      result += escape;
      index += escape.length;
      continue;
    }
    result += value[index];
    index += 1;
    length += 1;
  }
  return `${result}${value.includes(`${ESCAPE}[`) ? RESET : ''}${suffix}`;
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
