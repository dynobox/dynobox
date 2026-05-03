/**
 * Identifiers for the agent harnesses Dynobox can drive.
 *
 * Adding a value here is non-breaking; removing one is.
 */
export const HARNESS_IDS = ['claude-code', 'codex'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];
