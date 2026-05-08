/**
 * Commander program & dispatch — public surface re-exported by the
 * top-level package barrel.
 */

export {
  type CliResult,
  configErrorExitCode,
  executeCli,
  type ExecuteCliOptions,
  type OutputWriter,
  placeholderExitCode,
  runCli,
  runFailureExitCode,
} from './execute.js';
