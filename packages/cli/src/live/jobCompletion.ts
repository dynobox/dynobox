import type {LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {renderAssertionDetails} from '../render/assertions.js';
import {renderDebugDetails} from '../render/debug.js';
import {
  renderHarnessFailureDetails,
  renderSetupFailureDetails,
} from '../render/failure.js';
import {renderCliMockDetails} from '../render/jobDetails.js';
import {renderWarningDetails} from '../render/warnings.js';
import type {RenderContext} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';

export type JobCompletionOptions = {
  debugLogPaths?: DebugLogPaths;
  configuredCliMockNames?: readonly string[];
};

/**
 * Render the post-job details block printed in live mode after a job
 * finishes (failure details, assertion details, debug paths).
 */
export function renderLiveJobCompletion(
  result: LocalRunnerResult,
  assertionById: Map<string, IrAssertion>,
  ctx: RenderContext,
  options: JobCompletionOptions = {},
): string {
  const lines: string[] = [];
  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (result.status === 'harness_failed') {
    lines.push(renderHarnessFailureDetails(result, ctx));
  }
  lines.push(
    renderCliMockDetails(result, options.configuredCliMockNames ?? [], ctx),
  );
  lines.push(renderWarningDetails(result, ctx));
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
        options.debugLogPaths === undefined
          ? {}
          : {debugLogPaths: options.debugLogPaths},
      ),
    );
  }
  return `${lines.join('')}\n`;
}
