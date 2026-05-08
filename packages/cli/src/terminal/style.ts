/**
 * Color and symbol styling. Reads `RenderContext` to honor `color` and
 * `usePlainSymbols` settings.
 */

import {DIM, GREEN, PURPLE, RED, RESET, YELLOW} from './ansi.js';
import type {RenderContext} from './renderContext.js';

type StatusKind = 'pass' | 'fail' | 'skip' | 'running';
type StyleKind = 'brand' | 'pass' | 'fail' | 'skip' | 'dim';

/** Pick the unicode (or plain ASCII) glyph for a phase/job status. */
export function symbol(ctx: RenderContext, status: StatusKind): string {
  if (ctx.usePlainSymbols) {
    if (status === 'pass') return '[ ok ]';
    if (status === 'fail') return '[FAIL]';
    if (status === 'skip') return '[skip]';
    return '[ .. ]';
  }

  if (status === 'pass') return '✓';
  if (status === 'fail') return '✗';
  if (status === 'skip') return '–';
  return '◐';
}

/**
 * Apply a status-appropriate color to `value`. `'plain'` is a no-op so
 * callers can branch on a single status type.
 */
export function colorStatus(
  ctx: RenderContext,
  value: string,
  status: 'pass' | 'fail' | 'skip' | 'plain',
): string {
  if (status === 'plain') return value;
  return style(ctx, value, status);
}

/** Wrap `value` in an ANSI color/style if `ctx.color` is enabled. */
export function style(
  ctx: Pick<RenderContext, 'color'>,
  value: string,
  kind: StyleKind,
): string {
  if (!ctx.color) return value;
  const code = ANSI_BY_KIND[kind];
  return `${code}${value}${RESET}`;
}

/** Convenience for `style(ctx, value, 'dim')`. */
export function dim(ctx: Pick<RenderContext, 'color'>, value: string): string {
  return style(ctx, value, 'dim');
}

const ANSI_BY_KIND: Record<StyleKind, string> = {
  brand: PURPLE,
  pass: GREEN,
  fail: RED,
  skip: YELLOW,
  dim: DIM,
};
