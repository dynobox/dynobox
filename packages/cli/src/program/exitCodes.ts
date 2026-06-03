/**
 * Process exit codes returned by the CLI.
 *
 * Kept as constants (not enums) so command wiring and tests can compare
 * against them numerically.
 */

/** Config failed to load, parse, or validate; or CLI flags were invalid. */
export const configErrorExitCode = 1;

/** At least one job ran to completion but did not pass. */
export const runFailureExitCode = 1;
