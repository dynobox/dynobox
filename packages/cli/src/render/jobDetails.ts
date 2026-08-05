/**
 * Per-job detail block in static (non-live) output: phase rows + failure
 * details + assertion details + (in debug mode) artifact paths.
 *
 * Composes the smaller per-section renderers; itself the body of an expanded
 * job row in `runOutput.ts`.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  dim,
  escapeTerminalText,
  type RenderContext,
} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';
import {renderAssertionDetails} from './assertions.js';
import {renderDebugDetails} from './debug.js';
import {
  renderFailureDiagnostics,
  renderSetupFailureDetails,
} from './failure.js';
import {
  renderAssertionsPhase,
  renderHarnessPhase,
  renderSetupPhase,
} from './phases.js';
import {renderWarningDetails} from './warnings.js';

export type JobDetailsOptions = {
  debugLogPaths?: DebugLogPaths;
  configuredCliMockNames?: readonly string[];
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

export function renderCliMockDetails(
  result: LocalRunnerResult,
  configuredNames: readonly string[],
  ctx: RenderContext,
): string {
  const lines: string[] = [];
  if (configuredNames.length > 0) {
    const detail = truncateCliText(
      `cli mocks: ${configuredNames.map(formatCliMockToken).join(', ')}`,
      Math.max(0, ctx.width - 8),
    );
    lines.push(`        ${dim(ctx, detail)}\n`);
  }
  for (const call of result.cliMockCalls) {
    const command = [
      formatCliMockToken(call.executable),
      ...call.argv.map(formatCliMockToken),
    ].join(' ');
    lines.push(
      `        ${dim(ctx, formatCliMockCall(command, call.exitCode, ctx.width - 8))}\n`,
    );
  }
  return lines.join('');
}

function formatCliMockToken(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return escapeTerminalText(JSON.stringify(value));
}

function formatCliMockCall(
  command: string,
  exitCode: number,
  maxLength: number,
): string {
  const available = Math.max(0, maxLength);
  const suffix = ` -> exit ${exitCode}`;
  if (available === 0) return '';
  if (available <= suffix.length) return suffix.slice(-available);

  const prefix = 'cli mock: ';
  const commandLength = available - prefix.length - suffix.length;
  if (commandLength <= 0) {
    return `${prefix.slice(0, available - suffix.length)}${suffix}`;
  }
  return `${prefix}${truncateCliText(command, commandLength)}${suffix}`;
}

function truncateCliText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return '.'.repeat(Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 3)}...`;
}
