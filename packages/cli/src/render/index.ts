/**
 * Internal render barrel. All exports here are pure string-producing functions —
 * no side effects, no I/O. Both the static and live output paths consume
 * helpers from this module.
 */

export {
  type AssertionDetailsOptions,
  renderAssertionDetails,
} from './assertions.js';
export {
  renderConfigErrorMessage,
  renderRunConfigErrorMessage,
} from './configError.js';
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
export {
  buildGroupedRunView,
  type GroupedDyno,
  type GroupedHarnessGroup,
  type GroupedJobEntry,
  type GroupedScenario,
  harnessLabelColumnWidth,
  renderDynoLine,
  renderGroupedRun,
  renderHarnessGroupRow,
  renderIterationDetailLines,
  renderIterationResultLine,
  renderRunningGroupRow,
  renderRunningIterationRow,
  renderScenarioLine,
  renderSingleJobFailureDetails,
  type RowLabelOptions,
} from './groupedRun.js';
export {renderRunHeader} from './header.js';
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
export {
  formatJobHarness,
  iterationCount,
  renderDiscoverySummary,
  type RunDynoGroup,
  uniqueHarnessLabels,
} from './plan.js';
export {renderQuietRun} from './quiet.js';
export {renderRunOutput, type RenderRunOutputInput} from './runOutput.js';
export {
  renderRunSummary,
  runSummarySegments,
  type RunSummaryTotals,
  summarizeRunResults,
} from './summary.js';
export {renderJsonValidateOutput} from './validateReporter.js';
export {describeWarning, renderWarningDetails} from './warnings.js';
