import {describe, expect, it, vi} from 'vitest';

import {createLiveDashboard} from './dashboard.js';

describe('createLiveDashboard', () => {
  it('redraws independent harness blocks as one terminal region', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const writes: string[] = [];
    const dashboard = createLiveDashboard((value) => writes.push(value), 'a');

    dashboard.start([
      {headline: 'claude · model: sonnet\n  running'},
      {headline: 'codex · model: gpt-5\n  running'},
    ]);
    dashboard.emit(0, {
      kind: 'update',
      render: (frame, nowMs) => `claude ${frame} ${nowMs}`,
    });
    dashboard.emit(1, {kind: 'commit', text: 'codex setup passed'});
    dashboard.tick('b');
    dashboard.clear();

    expect(writes[0]).toBe(
      'claude · model: sonnet\n  running\ncodex · model: gpt-5\n  running\n',
    );
    expect(writes).toContain('\x1b[4A\r\x1b[J');
    expect(writes).toContain('\x1b[5A\r\x1b[J');
    expect(writes.join('')).toContain('claude a 100');
    expect(writes.join('')).toContain('codex setup passed');
    expect(writes.join('')).toContain('claude b 100');
    expect(writes.at(-1)).toBe('\x1b[6A\r\x1b[J');

    vi.restoreAllMocks();
  });
});
