import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import {buildRunMatrix, type RunMatrix} from '../jobs.js';
import {
  createRenderContext,
  dim,
  type RenderContext,
  style,
  truncate,
  visibleLength,
} from '../terminal/index.js';

const MAX_SCENARIO_WIDTH = 28;
const MAX_HARNESS_WIDTH = 24;

export function renderPassRateMatrix(
  jobs: readonly LocalRunnerJob[],
  results: readonly LocalRunnerResult[],
  ctx: RenderContext = createRenderContext(),
): string {
  return renderPassRateMatrixFromMatrix(buildRunMatrix(jobs, results), ctx);
}

export function renderPassRateMatrixFromMatrix(
  matrix: RunMatrix,
  ctx: RenderContext = createRenderContext(),
): string {
  if (matrix.scenarios.length === 0 || matrix.harnesses.length === 0) {
    return '';
  }

  const scenarioLabels = matrix.scenarios.map((scenario) =>
    truncate(scenario.name, MAX_SCENARIO_WIDTH),
  );
  const harnessLabels = matrix.harnesses.map((harness) =>
    truncate(formatMatrixHarness(harness), MAX_HARNESS_WIDTH),
  );
  const scenarioWidth = Math.max(
    'scenario'.length,
    ...scenarioLabels.map(visibleLength),
  );
  const cellWidth = Math.max(
    5,
    ...harnessLabels.map(visibleLength),
    ...matrix.cells.map((cell) => visibleLength(formatCell(cell, ctx))),
  );

  const lines = [
    `  ${style(ctx, 'pass-rate matrix', 'brand')}\n`,
    `  ${pad('scenario', scenarioWidth)}  ${harnessLabels
      .map((label) => pad(label, cellWidth))
      .join('  ')}\n`,
  ];

  for (const [index, scenario] of matrix.scenarios.entries()) {
    const scenarioLabel = scenarioLabels[index] ?? scenario.name;
    const cells = matrix.harnesses.map((harness) => {
      const cell = matrix.cells.find(
        (candidate) =>
          candidate.scenarioId === scenario.id &&
          sameHarness(candidate.harness, harness),
      );
      if (cell === undefined) return dim(ctx, pad('-', cellWidth));

      return pad(formatCell(cell, ctx), cellWidth);
    });
    lines.push(`  ${pad(scenarioLabel, scenarioWidth)}  ${cells.join('  ')}\n`);
  }

  return `${lines.join('')}\n`;
}

function formatMatrixHarness(
  harness: Pick<
    RunMatrix['harnesses'][number],
    'id' | 'model' | 'permissionMode'
  >,
): string {
  const parts: string[] = [harness.id];
  if (harness.model !== undefined) parts.push(harness.model);
  if (harness.permissionMode !== undefined) parts.push(harness.permissionMode);
  return parts.join('/');
}

function formatCell(
  cell: Pick<RunMatrix['cells'][number], 'runs' | 'passed' | 'total'>,
  ctx: RenderContext,
): string {
  const sortedRuns = [...cell.runs].sort((a, b) => a.iteration - b.iteration);
  return sortedRuns.map((run) => mark(run.passed, ctx)).join('');
}

function mark(passed: boolean, ctx: RenderContext): string {
  return style(ctx, passed ? '.' : 'F', passed ? 'pass' : 'fail');
}

function sameHarness(
  a: Pick<RunMatrix['harnesses'][number], 'id' | 'model' | 'permissionMode'>,
  b: Pick<RunMatrix['harnesses'][number], 'id' | 'model' | 'permissionMode'>,
): boolean {
  return (
    a.id === b.id &&
    a.model === b.model &&
    a.permissionMode === b.permissionMode
  );
}

function pad(value: string, width: number): string {
  const gap = width - visibleLength(value);
  return gap <= 0 ? value : `${value}${' '.repeat(gap)}`;
}
