import type {LocalRunnerResult} from '@dynobox/runner-local';

import {
  dim,
  escapeTerminalText,
  type RenderContext,
  truncate,
} from '../terminal/index.js';

/** One line of a user message, escaped and fitted to `maxLength`. */
export function formatTurnMessage(message: string, maxLength: number): string {
  const text = escapeTerminalText(message.replace(/\s+/g, ' ').trim());
  const available = Math.max(0, maxLength);
  if (text.length <= available) return text;
  if (available <= 3) return '.'.repeat(available);
  return truncate(text, available);
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
        `${label}${turn.prompt}`,
        ctx.width - 8,
      );
      return `        ${dim(ctx, message)}\n`;
    })
    .join('');
}
