/**
 * Per-job detail block in static (non-live) output: phase rows + failure
 * details + assertion details + (in debug mode) artifact paths.
 *
 * Composes the smaller per-section renderers; itself the body of an expanded
 * job row in `runOutput.ts`.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import type {RenderContext} from '../terminal/index.js';
import {renderAssertionDetails} from './assertions.js';
import {renderDebugDetails} from './debug.js';
import {
  renderHarnessFailureDetails,
  renderSetupFailureDetails,
} from './failure.js';
import {
  renderAssertionsPhase,
  renderHarnessPhase,
  renderSetupPhase,
} from './phases.js';

export type JobDetailsOptions = {
  transcriptLogPath?: string;
};

export function renderJobDetails(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
  options: JobDetailsOptions = {},
): string {
  const omitIcons = result.passed;
  const lines = [
    renderSetupPhase(result, ctx, omitIcons),
    renderHarnessPhase(result, ctx, omitIcons),
    renderAssertionsPhase(result, ctx, omitIcons),
  ];

  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (result.status === 'harness_failed') {
    lines.push(renderHarnessFailureDetails(result, ctx));
  }

  if (
    result.assertionResults.length > 0 &&
    (result.status !== 'harness_failed' || result.harnessResult !== undefined)
  ) {
    lines.push(renderAssertionDetails(result, assertionById, ctx));
  }

  if (ctx.mode === 'debug') {
    lines.push(
      renderDebugDetails(
        result,
        ctx,
        options.transcriptLogPath === undefined
          ? {}
          : {transcriptLogPath: options.transcriptLogPath},
      ),
    );
  }

  return `${lines.join('')}\n`;
}
