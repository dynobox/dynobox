/**
 * Live-mode terminal output: a multi-harness dashboard, a spinner, and the
 * pure event→line mapping that connects runner progress to dashboard rows.
 *
 * Everything that wouldn't exist in a strictly static-output CLI lives here.
 */

export {
  createLiveDashboard,
  type LiveDashboard,
  type LiveDashboardBlock,
  type LiveLine,
  type LiveRender,
} from './dashboard.js';
export {type LiveJobState, renderLiveProgressEvent} from './progress.js';
export {
  createSpinner,
  type Spinner,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from './spinner.js';
