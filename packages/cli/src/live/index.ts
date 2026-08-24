/**
 * Live-mode terminal output: a stateful writer (cursor manipulation), a
 * spinner (interval timer), and the pure event→line mapping that connects
 * runner progress events to the writer.
 *
 * Everything that wouldn't exist in a strictly static-output CLI lives here.
 */

export {
  createLiveDashboard,
  type LiveDashboard,
  type LiveDashboardBlock,
} from './dashboard.js';
export {
  type JobCompletionOptions,
  renderLiveJobCompletion,
} from './jobCompletion.js';
export {type LiveJobState, renderLiveProgressEvent} from './progress.js';
export {
  createSpinner,
  type Spinner,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from './spinner.js';
export {
  createLiveWriter,
  type LiveLine,
  type LiveRender,
  type LiveWriter,
} from './writer.js';
