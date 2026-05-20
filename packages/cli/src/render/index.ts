/**
 * Internal render barrel. All exports here are pure string-producing functions —
 * no side effects, no I/O. Both the static and live output paths consume
 * helpers from this module.
 */

export {renderAssertionDetails} from './assertions.js';
export {renderRunConfigErrorMessage} from './configError.js';
export {renderDebugDetails} from './debug.js';
export {
  describeAssertion,
  describeExpectation,
  describeToolEvent,
  isShellToolEvent,
} from './describe.js';
export {
  renderHarnessFailureDetails,
  renderSetupFailureDetails,
} from './failure.js';
export {renderRunHeader} from './header.js';
export {type HeadlineStatus, renderHeadline} from './headline.js';
export {renderJobDetails} from './jobDetails.js';
export {renderJsonRunOutput} from './jsonReporter.js';
export {
  type PhaseRowInput,
  type PhaseStatus,
  renderAssertionsPhase,
  renderHarnessPhase,
  renderPhaseRow,
  renderSetupPhase,
  setupDurationMs,
} from './phases.js';
export {renderPlaceholderMessage} from './placeholder.js';
export {formatJobHarness, renderPlan, renderPlanFromMatrix} from './plan.js';
export {renderQuietRun} from './quiet.js';
export {renderRunOutput, type RenderRunOutputInput} from './runOutput.js';
export {renderRunSummary} from './summary.js';
export {describeWarning, renderWarningDetails} from './warnings.js';
