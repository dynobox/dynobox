import {describe, expect, it} from 'vitest';

import {GREEN, RESET, visibleLength} from './ansi.js';
import {leftRight} from './layout.js';

describe('leftRight', () => {
  it('clips an overflowing ANSI-styled left value to the width budget', () => {
    const output = leftRight(
      `        ${GREEN}✓${RESET} harness    Bash: ${'x'.repeat(42)} 12 tools`,
      `${GREEN}1.2s${RESET}`,
      60,
    );

    expect(visibleLength(output)).toBe(60);
    expect(output).toContain('...');
    expect(output.endsWith(` ${GREEN}1.2s${RESET}`)).toBe(true);
  });

  it('clips a lone left value to the width budget', () => {
    const output = leftRight('x'.repeat(80), '', 72);

    expect(visibleLength(output)).toBe(72);
    expect(output).toMatch(/\.\.\.$/);
  });
});
