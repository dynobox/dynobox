import type {LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {createRenderContext, visibleLength} from '../terminal/index.js';
import {formatTurnMessage, renderTurnDetails} from './turns.js';

describe('formatTurnMessage', () => {
  it('collapses whitespace, escapes control characters, and truncates', () => {
    expect(formatTurnMessage('Use\n  UUID\tkeys.', 40)).toBe('Use UUID keys.');
    expect(formatTurnMessage('a\u001b[31mred', 40)).toBe('a\\u001b[31mred');
    expect(formatTurnMessage('x'.repeat(20), 10)).toBe('xxxxxxx...');
  });

  it.each([-1, 0, 1, 2, 3])('fits a %i-character allowance', (width) => {
    expect(formatTurnMessage('A long reply.', width)).toBe(
      '.'.repeat(Math.max(0, width)),
    );
  });
});

describe('renderTurnDetails', () => {
  const ctx = createRenderContext({color: false, terminalWidth: 80});

  it('lists each user reply after the first prompt', () => {
    const result = {
      turns: [
        {prompt: 'Add a users table.', durationMs: 1},
        {prompt: 'UUID keys.', durationMs: 1},
        {prompt: 'Add an index.', durationMs: 1},
      ],
    } as LocalRunnerResult;

    expect(renderTurnDetails(result, ctx)).toBe(
      '        turn 2: UUID keys.\n        turn 3: Add an index.\n',
    );
  });

  it('renders nothing for single-turn jobs', () => {
    expect(renderTurnDetails({} as LocalRunnerResult, ctx)).toBe('');
  });

  it.each([12, 16, 18, 30])(
    'fits replies within a %i-column terminal',
    (width) => {
      const output = renderTurnDetails(
        {
          turns: [
            {prompt: 'Start.', durationMs: 1},
            {
              prompt: 'Use\nUUID\u001b[31m keys and add an index.',
              durationMs: 1,
            },
          ],
        } as LocalRunnerResult,
        createRenderContext({color: false, terminalWidth: width}),
      );

      expect(visibleLength(output.trimEnd())).toBeLessThanOrEqual(width);
      expect(output).not.toContain('\u001b');
    },
  );
});
