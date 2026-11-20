import type {LocalRunnerResult} from '@dynobox/runner-local';

import {
  dim,
  escapeTerminalText,
  type RenderContext,
  truncate,
} from '../terminal/index.js';

/** One line of a user message, escaped and fitted to `maxLength`. */
export function formatTurnMessage(message: string, maxLength: number): string {
  return truncate(
    escapeTerminalText(message.replace(/\s+/g, ' ').trim()),
    Math.max(0, maxLength),
  );
}

/** The user's replies in a multi-turn job, one line per later turn. */
export function renderTurnDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
): string {
  return (result.turns ?? [])
    .slice(1)
    .map((turn, index) => {
      const label = `turn ${index + 2}: `;
      const message = formatTurnMessage(
        turn.prompt,
        ctx.width - 8 - label.length,
      );
      return `        ${dim(ctx, `${label}${message}`)}\n`;
    })
    .join('');
}
