import {describe, expect, it} from 'vitest';

import {createRenderContext, visibleLength} from '../terminal/index.js';
import {renderPhaseRow} from './phases.js';

describe('renderPhaseRow', () => {
  it.each([60, 72, 80, 100])(
    'keeps phase rows within a %i-column terminal',
    (terminalWidth) => {
      const ctx = createRenderContext({color: true, terminalWidth});
      const output = renderPhaseRow(ctx, {
        status: 'running',
        label: 'harness',
        detail: 'running prompt...',
        durationMs: 1200,
        spinnerFrame: 'a',
      });

      expect(visibleLength(output)).toBe(terminalWidth);
    },
  );

  it.each([60, 72])(
    'clips long tool progress within a %i-column terminal',
    (terminalWidth) => {
      const ctx = createRenderContext({color: true, terminalWidth});
      const output = renderPhaseRow(ctx, {
        status: 'running',
        label: 'harness',
        detail: `Bash: ${'x'.repeat(42)} 12 tools`,
        durationMs: 1200,
        spinnerFrame: 'a',
      });

      expect(visibleLength(output)).toBe(terminalWidth);
      expect(output).toContain('...');
    },
  );
});
