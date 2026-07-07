import {describe, expect, it} from 'vitest';

import {formatDuration} from './format.js';

describe('formatDuration', () => {
  it('rounds near-minute durations into minute format', () => {
    expect(formatDuration(59_949)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m00s');
  });
});
