/**
 * Formatters for human-readable terminal output.
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

/** Escape control characters before writing untrusted text to a terminal. */
export function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)) {
        return character;
      }
      const jsonEscape = JSON.stringify(character).slice(1, -1);
      if (jsonEscape !== character) return jsonEscape;
      return `\\u${code.toString(16).padStart(4, '0')}`;
    })
    .join('');
}
