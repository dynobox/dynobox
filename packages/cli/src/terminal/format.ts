/**
 * Numeric formatters for human-readable terminal output.
 */

/**
 * Pluralize a count: `1 scenario`, `3 scenarios`.
 */
export function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * Format a duration with one decimal place of seconds, e.g. `1.2s`.
 *
 * Used for finalized phase/run durations where a stable display is desirable.
 */
export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Format a duration as whole seconds, e.g. `1s`.
 *
 * Used during live ticks so the trailing digit doesn't flicker every frame.
 */
export function formatLiveDuration(durationMs: number): string {
  return `${Math.floor(durationMs / 1000)}s`;
}
