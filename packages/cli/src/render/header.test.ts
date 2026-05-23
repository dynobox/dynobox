import {describe, expect, it} from 'vitest';

import {renderRunHeader} from './header.js';

describe('renderRunHeader', () => {
  it('shows the plan summary line', () => {
    const header = renderRunHeader('./config.ts', [
      {
        id: 'scenario.test.iteration.0',
        iteration: 0,
        harness: 'claude-code',
        scenario: {
          id: 'scenario.test',
          name: 'test',
          prompt: 'Run a test.',
          harnesses: [{id: 'claude-code'}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [],
        },
      },
    ]);

    expect(header).toContain('plan     1 scenario · 1 harness · 1 iteration');
  });
});
