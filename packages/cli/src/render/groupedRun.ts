/**
 * Grouped, test-runner-style run output: dynos as top-level groups,
 * scenarios beneath them, and one result row per harness group.
 *
 * Used by the static output path (`runOutput.ts`); the live path in
 * `program/runCommand.ts` reuses the row/detail renderers so the final
 * live output matches the static shape.
 */

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {assertionByIdForJobs} from '../jobs.js';
import {
  colorStatus,
  dim,
  formatCount,
  formatDuration,
  leftRight,
  type RenderContext,
  style,
  symbol,
  truncate,
  visibleLength,
} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';
import {renderAssertionDetails} from './assertions.js';
import {
  renderFailureDiagnostics,
  renderSetupFailureDetails,
} from './failure.js';
import {renderJobDetails} from './jobDetails.js';
import {
  formatJobHarness,
  type RunDynoGroup,
  uniqueHarnessLabels,
} from './plan.js';
import {describeWarning, renderWarningDetails} from './warnings.js';

const DYNO_INDENT = '  ';
const SCENARIO_INDENT = '    ';
const ROW_INDENT = '      ';
const DETAIL_INDENT = '        ';
const MAX_HARNESS_COLUMN_WIDTH = 24;

export type GroupedJobEntry = {
  job: LocalRunnerJob;
  result: LocalRunnerResult;
};

export type GroupedHarnessGroup = {
  label: string;
  entries: GroupedJobEntry[];
};

export type GroupedScenario = {
  name: string;
  harnessGroups: GroupedHarnessGroup[];
};

export type GroupedDyno = {
  label: string;
  scenarios: GroupedScenario[];
};

export type JobHarnessGroup = {
  label: string;
  jobs: LocalRunnerJob[];
};

export type JobScenarioGroup = {
  name: string;
  harnessGroups: JobHarnessGroup[];
};

/** Group jobs by scenario -> harness label, preserving first-seen order. */
export function groupJobs(jobs: readonly LocalRunnerJob[]): JobScenarioGroup[] {
  const scenarios: JobScenarioGroup[] = [];
  const scenarioById = new Map<string, JobScenarioGroup>();
  for (const job of jobs) {
    let scenario = scenarioById.get(job.scenario.id);
    if (scenario === undefined) {
      scenario = {name: job.scenario.name, harnessGroups: []};
      scenarioById.set(job.scenario.id, scenario);
      scenarios.push(scenario);
    }
    const label = formatJobHarness(job);
    let group = scenario.harnessGroups.find(
      (candidate) => candidate.label === label,
    );
    if (group === undefined) {
      group = {label, jobs: []};
      scenario.harnessGroups.push(group);
    }
    group.jobs.push(job);
  }
  return scenarios;
}

function assertPositionalPairing(
  dynos: readonly RunDynoGroup[],
  results: readonly LocalRunnerResult[],
): void {
  const jobs = dynos.flatMap((dyno) => dyno.jobs);
  const ids = jobs.map((job) => job.id);
  if (new Set(ids).size !== ids.length) return;

  for (let index = 0; index < jobs.length; index++) {
    const result = results[index];
    if (result !== undefined && result.jobId !== jobs[index]!.id) {
      throw new Error(
        `Result/job mismatch at index ${index}: expected ${jobs[index]!.id}, got ${result.jobId}`,
      );
    }
  }
}

/**
 * Group `(job, result)` pairs by dyno → scenario → harness label, preserving
 * job order.
 *
 * Results pair positionally with the flattened job order (jobs execute in
 * dyno order and results append in execution order). Pairing by job id would
 * mis-attribute results when two dyno files produce identical job ids (same
 * scenario name, harness, and iteration). Jobs without a result are dropped.
 */
export function buildGroupedRunView(
  dynos: readonly RunDynoGroup[],
  results: readonly LocalRunnerResult[],
): GroupedDyno[] {
  assertPositionalPairing(dynos, results);
  let resultIndex = 0;
  return dynos.map((dyno) => {
    const resultByJob = new Map<LocalRunnerJob, LocalRunnerResult>();
    for (const job of dyno.jobs) {
      const result = results[resultIndex];
      resultIndex += 1;
      if (result === undefined) continue;
      resultByJob.set(job, result);
    }
    const scenarios = groupJobs(dyno.jobs).flatMap((scenario) => {
      const harnessGroups = scenario.harnessGroups.flatMap((group) => {
        const entries = group.jobs.flatMap((job) => {
          const result = resultByJob.get(job);
          return result === undefined ? [] : [{job, result}];
        });
        return entries.length === 0 ? [] : [{label: group.label, entries}];
      });
      return harnessGroups.length === 0
        ? []
        : [{name: scenario.name, harnessGroups}];
    });
    return {label: dyno.name ?? dyno.path, scenarios};
  });
}

export type RowLabelOptions = {
  /** Harness label column; rendered (padded) only when the run has multiple labels. */
  harnessLabel?: string;
  harnessLabelWidth?: number;
};

/** Column width for aligned harness labels, capped for readability. */
export function harnessLabelColumnWidth(
  jobs: readonly LocalRunnerJob[],
): number {
  return uniqueHarnessLabels(jobs).reduce(
    (max, label) =>
      Math.max(max, visibleLength(truncate(label, MAX_HARNESS_COLUMN_WIDTH))),
    0,
  );
}

/**
 * Render the result row for one harness group: assertion status + duration
 * for a single iteration, job fraction + sparkline + aggregate duration for
 * multiple iterations.
 */
export function renderHarnessGroupRow(
  entries: readonly GroupedJobEntry[],
  ctx: RenderContext,
  options: RowLabelOptions = {},
): string {
  const status =
    entries.length === 1
      ? renderSingleIterationStatus(entries[0]!.result, ctx)
      : renderMultiIterationStatus(entries, ctx);
  const durationMs = entries.reduce(
    (sum, entry) => sum + entry.result.timing.totalMs,
    0,
  );
  const left = `${ROW_INDENT}${rowLabelPrefix(options)}${status}`;
  return leftRight(left, dim(ctx, formatDuration(durationMs)), ctx.width);
}

/** Transient headline shown while a harness group is running in live mode. */
export function renderRunningGroupRow(
  ctx: RenderContext,
  options: RowLabelOptions = {},
): string {
  const icon = symbol(ctx, 'running');
  return `${ROW_INDENT}${rowLabelPrefix(options)}${icon} ${dim(ctx, 'running')}`;
}

/** Render the `  {dyno label}` group line. */
export function renderDynoLine(label: string, ctx: RenderContext): string {
  return `${DYNO_INDENT}${style(ctx, truncate(label, ctx.width - DYNO_INDENT.length), 'brand')}`;
}

/** Render the `    {scenario name}` group line. */
export function renderScenarioLine(name: string, ctx: RenderContext): string {
  return `${SCENARIO_INDENT}${truncate(name, ctx.width - SCENARIO_INDENT.length)}`;
}

/**
 * Default-mode details under a failed (or warning) single-iteration row:
 * setup/harness failure diagnostics, warnings, and failed assertions.
 */
export function renderSingleJobFailureDetails(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  const lines: string[] = [];
  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (!result.passed && result.diagnostics.length > 0) {
    lines.push(renderFailureDiagnostics(result, ctx));
  }
  lines.push(renderWarningDetails(result, ctx));
  if (
    !result.passed &&
    result.assertionResults.length > 0 &&
    (result.status !== 'harness_failed' || result.harnessResult !== undefined)
  ) {
    lines.push(
      renderAssertionDetails(result, assertionById, ctx, {failedOnly: true}),
    );
  }
  return lines.join('');
}

/**
 * Default-mode details under a multi-iteration row: per failed iteration,
 * `iter N`-prefixed failed assertions with their expected/observed evidence,
 * or the setup/harness failure diagnostics, plus any warnings.
 */
export function renderIterationDetailLines(
  entries: readonly GroupedJobEntry[],
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
): string {
  const lines: string[] = [];
  for (const {job, result} of entries) {
    const iter = `iter ${job.iteration + 1}`;
    if (result.status === 'setup_failed') {
      lines.push(
        `${DETAIL_INDENT}${iter} ${colorStatus(ctx, `${symbol(ctx, 'fail')} setup failed`, 'fail')}\n`,
        renderSetupFailureDetails(result, ctx),
      );
    } else if (result.status === 'harness_failed') {
      lines.push(
        `${DETAIL_INDENT}${iter} ${colorStatus(ctx, `${symbol(ctx, 'fail')} harness failed`, 'fail')}\n`,
        renderFailureDiagnostics(result, ctx),
      );
    } else if (!result.passed) {
      if (result.verificationFailed) {
        lines.push(
          `${DETAIL_INDENT}${iter} ${colorStatus(ctx, `${symbol(ctx, 'fail')} verification failed`, 'fail')}\n`,
          renderFailureDiagnostics(result, ctx),
        );
      } else if (result.diagnostics.length > 0) {
        lines.push(renderFailureDiagnostics(result, ctx));
      }
      lines.push(
        renderAssertionDetails(result, assertionById, ctx, {
          failedOnly: true,
          linePrefix: `${iter} `,
        }),
      );
    }
    for (const warning of result.warnings) {
      lines.push(
        `${DETAIL_INDENT}${iter} ${colorStatus(ctx, 'warning', 'skip')} ${describeWarning(warning)}\n`,
      );
    }
  }
  return lines.join('');
}

/** One-line per-iteration status: `iter 2 ✗ 1 of 2 failed`. */
export function renderIterationResultLine(
  entry: GroupedJobEntry,
  ctx: RenderContext,
): string {
  const status = renderSingleIterationStatus(entry.result, ctx);
  const left = `${DETAIL_INDENT}iter ${entry.job.iteration + 1} ${status}`;
  return leftRight(
    left,
    dim(ctx, formatDuration(entry.result.timing.totalMs)),
    ctx.width,
  );
}

/** Transient headline shown while one iteration runs in expanded live mode. */
export function renderRunningIterationRow(
  iteration: number,
  ctx: RenderContext,
): string {
  return `${DETAIL_INDENT}iter ${iteration + 1} ${symbol(ctx, 'running')} ${dim(ctx, 'running')}`;
}

export type GroupedRunRenderInput = {
  dynos: readonly RunDynoGroup[];
  results: readonly LocalRunnerResult[];
  ctx: RenderContext;
  debugLogPaths?: Map<LocalRunnerJob, DebugLogPaths>;
};

/**
 * Render the full grouped run body (everything between the header and the
 * summary) for default, verbose, and debug static output.
 */
export function renderGroupedRun(input: GroupedRunRenderInput): string {
  const {dynos, results, ctx} = input;
  const jobs = dynos.flatMap((dyno) => dyno.jobs);
  const multiHarness = uniqueHarnessLabels(jobs).length > 1;
  const labelWidth = harnessLabelColumnWidth(jobs);
  const expandAll = ctx.mode === 'verbose' || ctx.mode === 'debug';
  const view = buildGroupedRunView(dynos, results);

  const lines: string[] = [];
  for (const [index, dyno] of view.entries()) {
    if (index > 0) lines.push('\n');
    lines.push(`${renderDynoLine(dyno.label, ctx)}\n`);
    for (const scenario of dyno.scenarios) {
      lines.push(`${renderScenarioLine(scenario.name, ctx)}\n`);
      for (const group of scenario.harnessGroups) {
        const rowOptions: RowLabelOptions = multiHarness
          ? {harnessLabel: group.label, harnessLabelWidth: labelWidth}
          : {};
        lines.push(
          `${renderHarnessGroupRow(group.entries, ctx, rowOptions)}\n`,
        );
        lines.push(renderGroupDetails(group, input, expandAll));
      }
    }
  }
  return lines.join('');
}

function renderGroupDetails(
  group: GroupedHarnessGroup,
  input: GroupedRunRenderInput,
  expandAll: boolean,
): string {
  const {ctx} = input;
  const assertionById = assertionByIdForJobs(
    group.entries.map((entry) => entry.job),
  );
  if (group.entries.length === 1) {
    const entry = group.entries[0]!;
    if (expandAll) {
      return renderJobDetails(entry.result, assertionById, ctx, {
        configuredCliMockNames: Object.keys(entry.job.scenario.cliMocks),
        ...debugLogPathsOption(input, entry),
      });
    }
    if (!entry.result.passed || entry.result.warnings.length > 0) {
      return renderSingleJobFailureDetails(entry.result, assertionById, ctx);
    }
    return '';
  }

  if (!expandAll) {
    return renderIterationDetailLines(group.entries, assertionById, ctx);
  }

  // Verbose/debug expand every iteration, matching single-iteration
  // expanded rows and the live expanded path.
  const lines: string[] = [];
  for (const entry of group.entries) {
    lines.push(`${renderIterationResultLine(entry, ctx)}\n`);
    lines.push(
      renderJobDetails(entry.result, assertionById, ctx, {
        configuredCliMockNames: Object.keys(entry.job.scenario.cliMocks),
        ...debugLogPathsOption(input, entry),
      }),
    );
  }
  return lines.join('');
}

function debugLogPathsOption(
  input: GroupedRunRenderInput,
  entry: GroupedJobEntry,
): {debugLogPaths?: DebugLogPaths} {
  const paths = input.debugLogPaths?.get(entry.job);
  return paths === undefined ? {} : {debugLogPaths: paths};
}

function rowLabelPrefix(options: RowLabelOptions): string {
  if (options.harnessLabel === undefined) return '';
  const label = truncate(options.harnessLabel, MAX_HARNESS_COLUMN_WIDTH);
  const width = options.harnessLabelWidth ?? visibleLength(label);
  const gap = Math.max(0, width - visibleLength(label));
  return `${label}${' '.repeat(gap)}  `;
}

function renderSingleIterationStatus(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  if (result.status === 'setup_failed') {
    return colorStatus(ctx, `${symbol(ctx, 'fail')} setup failed`, 'fail');
  }
  if (result.status === 'harness_failed') {
    return colorStatus(ctx, `${symbol(ctx, 'fail')} harness failed`, 'fail');
  }

  const total = result.assertionResults.length;
  if (result.passed) {
    const icon = colorStatus(ctx, symbol(ctx, 'pass'), 'pass');
    return `${icon} ${total === 0 ? 'no assertions' : formatCount(total, 'assertion')}`;
  }
  const failed = result.assertionResults.filter(
    (assertionResult) => !assertionResult.passed,
  ).length;
  if (failed === 0 && result.verificationFailed) {
    return colorStatus(
      ctx,
      `${symbol(ctx, 'fail')} verification failed`,
      'fail',
    );
  }
  return `${colorStatus(ctx, symbol(ctx, 'fail'), 'fail')} ${failed} of ${total} failed${result.verificationFailed ? '; verification failed' : ''}`;
}

function renderMultiIterationStatus(
  entries: readonly GroupedJobEntry[],
  ctx: RenderContext,
): string {
  const sorted = [...entries].sort((a, b) => a.job.iteration - b.job.iteration);
  const total = sorted.length;
  const failed = sorted.filter((entry) => !entry.result.passed).length;
  const sparkline = sorted
    .map((entry) =>
      entry.result.passed ? style(ctx, '.', 'pass') : style(ctx, 'F', 'fail'),
    )
    .join('');
  const fraction =
    failed === 0
      ? `${colorStatus(ctx, symbol(ctx, 'pass'), 'pass')} ${total}/${total} passed`
      : `${colorStatus(ctx, symbol(ctx, 'fail'), 'fail')} ${failed}/${total} failed`;
  return `${fraction}   ${sparkline}`;
}
