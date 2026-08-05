import {describe, expect, it} from 'vitest';

import {escapeTerminalText, formatDuration} from './format.js';

describe('formatDuration', () => {
  it('rounds near-minute durations into minute format', () => {
    expect(formatDuration(59_949)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m00s');
  });
});

describe('escapeTerminalText', () => {
  it('escapes line breaks and terminal control sequences', () => {
    expect(escapeTerminalText('line\n\u001b[31m\u009b2J')).toBe(
      'line\\n\\u001b[31m\\u009b2J',
    );
  });
});
