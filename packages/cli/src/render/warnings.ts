import type {
  LocalRunnerResult,
  LocalRunnerWarning,
} from '@dynobox/runner-local';

import {
  colorStatus,
  dim,
  type RenderContext,
  truncate,
} from '../terminal/index.js';

const COMMAND_PREVIEW_MAX = 68;

export function renderWarningDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  if (result.warnings.length === 0) return '';
  return result.warnings.map((warning) => renderWarning(warning, ctx)).join('');
}

export function describeWarning(warning: LocalRunnerWarning): string {
  if (warning.tool?.command !== undefined) {
    return `permission denied for shell command: ${truncateSingleLine(warning.tool.command, COMMAND_PREVIEW_MAX)}`;
  }
  if (warning.tool !== undefined) {
    return `permission denied for ${warning.tool.rawName}`;
  }
  return 'permission denied';
}

function renderWarning(
  warning: LocalRunnerWarning,
  ctx: RenderContext,
): string {
  const lines = [
    `        ${colorStatus(ctx, 'warning', 'skip')} ${describeWarning(warning)}\n`,
    `          ${warning.message}\n`,
  ];
  if (warning.tool?.command !== undefined) {
    lines.push(
      `          ${dim(ctx, `$ ${truncateSingleLine(warning.tool.command, COMMAND_PREVIEW_MAX)}`)}\n`,
    );
  }
  return lines.join('');
}

function truncateSingleLine(value: string, max: number): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), max);
}
