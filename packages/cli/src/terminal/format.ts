/**
 * Numeric formatters for human-readable terminal output.
 */

/**
 * Pluralize a count: `1 scenario`, `3 scenarios`. Pass `plural` for
 * irregular plurals: `formatCount(2, 'harness', 'harnesses')`.
 */
export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Format a duration with one decimal place of seconds, e.g. `1.2s`.
 * Durations of a minute or more render as `1m02s`.
 *
 * Used for finalized phase/run durations where a stable display is desirable.
 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 59.95) return `${totalSeconds.toFixed(1)}s`;
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/**
 * Format a duration as whole seconds, e.g. `1s`.
 *
 * Used during live ticks so the trailing digit doesn't flicker every frame.
 */
export function formatLiveDuration(durationMs: number): string {
  return `${Math.floor(durationMs / 1000)}s`;
}
