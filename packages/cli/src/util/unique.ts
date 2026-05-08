/**
 * Stable-order dedupe.
 */

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
