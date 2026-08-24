import {describe, expect, it, vi} from 'vitest';

import {createLiveDashboard} from './dashboard.js';

describe('createLiveDashboard', () => {
  it('redraws independent harness blocks as one terminal region', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const writes: string[] = [];
    const dashboard = createLiveDashboard(
      (value) => writes.push(value),
      true,
      'a',
    );

    dashboard.start([
      {headline: 'claude running'},
      {headline: 'codex running'},
    ]);
    dashboard.emit(0, {
      kind: 'update',
      render: (frame, nowMs) => `claude ${frame} ${nowMs}`,
    });
    dashboard.emit(1, {kind: 'commit', text: 'codex setup passed'});
    dashboard.tick('b');
    dashboard.clear();

    expect(writes[0]).toBe('claude running\ncodex running\n');
    expect(writes).toContain('\x1b[2A\r\x1b[J');
    expect(writes).toContain('\x1b[3A\r\x1b[J');
    expect(writes.join('')).toContain('claude a 100');
    expect(writes.join('')).toContain('codex setup passed');
    expect(writes.join('')).toContain('claude b 100');
    expect(writes.at(-1)).toBe('\x1b[4A\r\x1b[J');

    vi.restoreAllMocks();
  });

  it('appends only changed rows without ANSI support', () => {
    const writes: string[] = [];
    const dashboard = createLiveDashboard(
      (value) => writes.push(value),
      false,
      'a',
    );

    dashboard.start([
      {headline: 'claude running'},
      {headline: 'codex running'},
    ]);
    dashboard.emit(0, {kind: 'commit', text: 'claude setup passed'});
    dashboard.setHeadline(1, 'codex passed');
    dashboard.tick('b');
    dashboard.clear();

    expect(writes).toEqual([
      'claude running\ncodex running\n',
      'claude setup passed\n',
    ]);
  });
});
