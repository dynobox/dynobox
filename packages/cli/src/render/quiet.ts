/**
 * Quiet/CI-friendly run output: a one-line plan, a `.`/`F` mark per job, and
 * a compact failure list. Designed for log capture, not interactive viewing.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {assertionByIdForJobs} from '../jobs.js';
import {
  formatCount,
  formatDuration,
  type RenderContext,
} from '../terminal/index.js';
import {describeAssertion} from './describe.js';
import {
  buildGroupedRunView,
  type GroupedHarnessGroup,
  type GroupedJobEntry,
} from './groupedRun.js';
import {renderDiscoverySummary, type RunDynoGroup} from './plan.js';
import {type RunSummaryTotals, summarizeRunResults} from './summary.js';
import {describeWarning} from './warnings.js';

export function renderQuietRun(
  dynos: readonly RunDynoGroup[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext,
): string {
  const marks = results.map((result) => (result.passed ? '.' : 'F')).join('');
  const summaryPrefix = '  dynobox  ';
  const lines = [
    `${summaryPrefix}${renderDiscoverySummary(dynos, ctx.width - summaryPrefix.length)}\n\n`,
    `  ${marks}\n`,
  ];

  const view = buildGroupedRunView(dynos, results);
  const failedGroups: Array<{label: string; group: GroupedHarnessGroup}> = [];
  const warnedGroups: Array<{label: string; group: GroupedHarnessGroup}> = [];
  for (const dyno of view) {
    for (const scenario of dyno.scenarios) {
      for (const group of scenario.harnessGroups) {
        const label = `${dyno.label} / ${scenario.name} [${group.label}]`;
        if (group.entries.some((entry) => !entry.result.passed)) {
          failedGroups.push({label, group});
        }
        if (group.entries.some((entry) => entry.result.warnings.length > 0)) {
          warnedGroups.push({label, group});
        }
      }
    }
  }

  if (failedGroups.length > 0) {
    lines.push('\n');
    for (const {label, group} of failedGroups) {
      lines.push(`  FAIL  ${label}\n`);
      const multiIteration = group.entries.length > 1;
      for (const entry of group.entries) {
        if (entry.result.passed) continue;
        const prefix = multiIteration ? `iter ${entry.job.iteration + 1} ` : '';
        for (const detail of describeJobFailures(entry)) {
          lines.push(`        ${prefix}${detail}\n`);
        }
      }
    }
  }

  if (warnedGroups.length > 0) {
    lines.push('\n');
    for (const {label, group} of warnedGroups) {
      lines.push(`  WARN  ${label}\n`);
      const multiIteration = group.entries.length > 1;
      for (const entry of group.entries) {
        const prefix = multiIteration ? `iter ${entry.job.iteration + 1} ` : '';
        for (const warning of entry.result.warnings) {
          lines.push(`        ${prefix}${describeWarning(warning)}\n`);
        }
      }
    }
  }

  const totals = summarizeRunResults(results);
  lines.push(
    `\n  ${quietSummarySegments(totals).join(', ')} in ${formatDuration(totals.durationMs)}\n`,
  );
  return lines.join('');
}

function describeJobFailures(entry: GroupedJobEntry): string[] {
  const assertionById = assertionByIdForJobs([entry.job]);
  if (entry.result.status === 'setup_failed') return ['setup failed'];
  if (entry.result.status === 'harness_failed') {
    const lines = ['harness failed', ...entry.result.diagnostics];
    if (
      entry.result.assertionResults.length > 0 &&
      entry.result.harnessResult !== undefined
    ) {
      lines.push(...failedAssertionLabels(entry.result, assertionById));
    }
    return lines;
  }
  return failedAssertionLabels(entry.result, assertionById);
}

function failedAssertionLabels(
  result: GroupedJobEntry['result'],
  assertionById: Map<string, IrAssertion>,
): string[] {
  return result.assertionResults
    .filter((assertionResult) => !assertionResult.passed)
    .map((assertionResult) => {
      const assertion = assertionById.get(assertionResult.assertionId);
      return assertion === undefined
        ? assertionResult.type
        : describeAssertion(assertion);
    });
}

/** Job-led summary counts with labeled assertion detail, plain-text. */
function quietSummarySegments(totals: RunSummaryTotals): string[] {
  const segments: string[] = [];
  if (totals.failedAssertions > 0) {
    segments.push(`${totals.failedJobs} of ${totals.jobs} jobs failed`);
    segments.push(formatCount(totals.failedAssertions, 'failed assertion'));
  } else if (totals.failedJobs > 0) {
    segments.push(`${totals.failedJobs} of ${totals.jobs} jobs failed`);
  } else {
    segments.push(`${formatCount(totals.passedJobs, 'job')} passed`);
    segments.push(
      totals.passedAssertions === 0
        ? 'no assertions'
        : formatCount(totals.passedAssertions, 'assertion'),
    );
  }
  if (totals.jobErrors > 0) {
    segments.push(formatCount(totals.jobErrors, 'job error'));
  }
  if (totals.warnings > 0) {
    segments.push(formatCount(totals.warnings, 'warning'));
  }
  return segments;
}
