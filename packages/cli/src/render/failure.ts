/**
 * Detail blocks rendered when a job fails outside its assertions:
 * setup-command, harness invocation, and verification failures.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {
  colorStatus,
  dim,
  type RenderContext,
  truncate,
} from '../terminal/index.js';

const COMMAND_PREVIEW_MAX = 68;

/**
 * Render the failed setup command, its exit code, and any captured output.
 */
export function renderSetupFailureDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  const failed = result.setupResult.logs.find((log) => log.exitCode !== 0);
  if (failed === undefined) return '';

  const lines = [
    `        ${dim(ctx, `$ ${truncate(failed.command, COMMAND_PREVIEW_MAX)}`)}\n`,
    `          exit code ${failed.exitCode}\n`,
  ];
  const output = failed.stderr.trim() || failed.stdout.trim();
  if (output.length > 0) {
    lines.push(...output.split(/\r?\n/).map((line) => `          ${line}\n`));
  }
  return lines.join('');
}

/** Render runner-supplied diagnostics for a failed job. */
export function renderFailureDiagnostics(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  if (result.diagnostics.length === 0) return '';
  return result.diagnostics
    .map((diagnostic) => `        ${colorStatus(ctx, diagnostic, 'fail')}\n`)
    .join('');
}

export const renderHarnessFailureDetails = renderFailureDiagnostics;
