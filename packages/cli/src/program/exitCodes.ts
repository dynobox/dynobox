/**
 * Process exit codes returned by the CLI.
 *
 * Kept as constants (not enums) because they're surfaced as part of the
 * public API and consumers compare against them numerically.
 */

/** No subcommand supplied — printed the placeholder banner. */
export const placeholderExitCode = 1;

/** Config failed to load, parse, or validate; or CLI flags were invalid. */
export const configErrorExitCode = 1;

/** At least one job ran to completion but did not pass. */
export const runFailureExitCode = 1;
