import type {LocalRunnerJob} from '@dynobox/runner-local';

import {formatCount, visibleLength} from '../terminal/index.js';
import {unique} from '../util/unique.js';

/** One discovered dyno's identity plus the jobs built from it. */
export type RunDynoGroup = {
  name?: string;
  path: string;
  jobs: readonly LocalRunnerJob[];
};

/** Format a job's harness label, including model and permission mode when configured. */
export function formatJobHarness(
  job: Pick<LocalRunnerJob, 'harness' | 'model' | 'permissionMode'>,
): string {
  const parts: string[] = [job.harness];
  if (job.model !== undefined) parts.push(`model: ${job.model}`);
  if (job.permissionMode !== undefined)
    parts.push(`mode: ${job.permissionMode}`);
  return parts.join(' · ');
}

/** Unique harness labels across a run, in first-seen job order. */
export function uniqueHarnessLabels(jobs: readonly LocalRunnerJob[]): string[] {
  return unique(jobs.map((job) => formatJobHarness(job)));
}

/** Number of iterations in a run (jobs carry 0-based iteration indices). */
export function iterationCount(jobs: readonly LocalRunnerJob[]): number {
  return jobs.reduce((max, job) => Math.max(max, job.iteration + 1), 1);
}

/**
 * Render the discovery summary used in run headers and quiet output:
 * `1 dyno · 2 scenarios · harness: codex · model: gpt-5.4-mini`.
 *
 * When the full harness label list would push the line past `maxWidth`,
 * fall back to a count (`harnesses: 4`). Iterations only appear when the
 * run has more than one.
 */
export function renderDiscoverySummary(
  dynos: readonly RunDynoGroup[],
  maxWidth: number,
): string {
  const jobs = dynos.flatMap((dyno) => dyno.jobs);
  const scenarioCount = dynos.reduce(
    (sum, dyno) => sum + unique(dyno.jobs.map((job) => job.scenario.id)).length,
    0,
  );
  const harnessLabels = uniqueHarnessLabels(jobs);
  const iterations = iterationCount(jobs);

  const counts = `${formatCount(dynos.length, 'dyno')} · ${formatCount(scenarioCount, 'scenario')}`;
  const iterationPart = iterations > 1 ? ` · iterations: ${iterations}` : '';
  if (harnessLabels.length === 1) {
    const full = `${counts} · harness: ${harnessLabels[0]}${iterationPart}`;
    if (visibleLength(full) <= maxWidth) return full;
    return `${counts} · harnesses: 1${iterationPart}`;
  }

  const full = `${counts} · harnesses: ${harnessLabels.join(', ')}${iterationPart}`;
  if (visibleLength(full) <= maxWidth) return full;
  return `${counts} · harnesses: ${harnessLabels.length}${iterationPart}`;
}
