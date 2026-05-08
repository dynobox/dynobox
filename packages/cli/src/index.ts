/**
 * Public package entry. Surface area is intentionally small:
 *   - `executeCli` / `runCli` and their option/result types
 *   - The three exit-code constants
 *   - Job-matrix builders used by external integrations
 *   - A handful of pre-rendered output strings
 *
 * Internal modules (`program/`, `render/`, `live/`, `terminal/`, `util/`,
 * `jobs.ts`) are not part of the package API — depend on them at your own
 * risk.
 */

export {buildLocalRunnerJobs, buildRunMatrix, type RunMatrix} from './jobs.js';
export {
  type CliResult,
  configErrorExitCode,
  executeCli,
  type ExecuteCliOptions,
  placeholderExitCode,
  runCli,
  runFailureExitCode,
} from './program/index.js';
export {
  renderPlaceholderMessage,
  renderRunConfigErrorMessage,
  renderRunHeader,
  renderRunOutput,
  renderRunSummary,
} from './render/index.js';
