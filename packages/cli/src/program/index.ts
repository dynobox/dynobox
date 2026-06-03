/**
 * Commander program & dispatch helpers used by the binary and tests.
 * This module is internal to the CLI package.
 */

export {
  type CliResult,
  configErrorExitCode,
  executeCli,
  type ExecuteCliOptions,
  type OutputWriter,
  runCli,
  runFailureExitCode,
} from './execute.js';
