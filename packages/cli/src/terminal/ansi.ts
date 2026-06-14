/**
 * ANSI escape sequences and helpers for measuring text that may contain them.
 *
 * Pure constants and a single regex; no behavior. Higher-level styling lives in
 * {@link ./style.ts}; layout helpers that need to ignore ANSI live in
 * {@link ./layout.ts}.
 */

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const GREEN = '\x1b[38;5;42m';
export const RED = '\x1b[38;5;167m';
export const YELLOW = '\x1b[38;5;220m';
export const DIM = '\x1b[2m';

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  'g',
);

/** Length of `value` ignoring ANSI color escapes. */
export function visibleLength(value: string): number {
  return value.replace(ANSI_ESCAPE_PATTERN, '').length;
}
