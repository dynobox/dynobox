import type {LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {renderAssertionDetails} from '../render/assertions.js';
import {renderDebugDetails} from '../render/debug.js';
import {
  renderFailureDiagnostics,
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
  lines.push(
    renderCliMockDetails(result, options.configuredCliMockNames ?? [], ctx),
  );
  if (result.status === 'setup_failed') {
    lines.push(renderSetupFailureDetails(result, ctx));
  } else if (!result.passed && result.diagnostics.length > 0) {
    lines.push(renderFailureDiagnostics(result, ctx));
  }
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
