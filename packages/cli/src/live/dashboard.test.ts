import {PassThrough, Writable} from 'node:stream';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {createLiveDashboard} from './dashboard.js';

afterEach(() => vi.restoreAllMocks());

// The dashboard uses cursor-up, carriage-return, and erase-to-end-of-screen.
// Interpret those controls so tests check the screen left after redraws.
function terminalScreen(writes: readonly string[]): string {
  let rows = [''];
  let row = 0;
  let column = 0;
  const escape = String.fromCharCode(27);
  const controls = new RegExp(
    `${escape}\\[\\d+A|${escape}\\[J|\\r|\\n|[^${escape}\\r\\n]+`,
    'g',
  );
  const tokens = writes.join('').match(controls) ?? [];
  for (const token of tokens) {
    if (token.startsWith('\x1b[') && token.endsWith('A')) {
      row = Math.max(0, row - Number(token.slice(2, -1)));
    } else if (token === '\x1b[J') {
      rows = rows.slice(0, row + 1);
      rows[row] = (rows[row] ?? '').slice(0, column);
    } else if (token === '\r') {
      column = 0;
    } else if (token === '\n') {
      row += 1;
      column = 0;
    } else {
      const previous = rows[row] ?? '';
      rows[row] =
        previous.slice(0, column) +
        token +
        previous.slice(column + token.length);
      column += token.length;
    }
  }
  return rows.join('\n').trimEnd();
}

function createFixture() {
  const writes: string[] = [];
  const stderr = new PassThrough();
  stderr.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
  const dashboard = createLiveDashboard((value) => writes.push(value), 'a', {
    stderr,
  });
  return {writes, stderr, dashboard};
}

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
  });

  it('keeps a multiline stderr diagnostic above later redraws', () => {
    const {writes, stderr, dashboard} = createFixture();
    const originalWrite = stderr.write;
    try {
      dashboard.start([{headline: 'codex\n  running'}]);
      dashboard.emit(0, {
        kind: 'update',
        render: (frame) => `harness ${frame}`,
      });
      const message =
        'Failed to handle request: Passthrough loop detected.\n\nTarget: http://127.0.0.1:8000/\n';
      stderr.write(message);
      dashboard.tick('b');
      expect(terminalScreen(writes)).toBe(
        `${message}codex\n  running\nharness b`,
      );
      dashboard.clear();
      expect(terminalScreen(writes)).toBe(message.trimEnd());
      expect(stderr.write).toBe(originalWrite);
    } finally {
      dashboard.clear();
    }
  });

  it('waits for a complete stderr line before resuming animation', () => {
    const {writes, stderr, dashboard} = createFixture();
    try {
      dashboard.start([{headline: 'codex\n  running'}]);
      dashboard.emit(0, {
        kind: 'update',
        render: (frame) => `harness ${frame}`,
      });
      stderr.write('Failed to handle ');
      dashboard.tick('b');
      dashboard.setHeadline(0, 'codex\n  still running');
      expect(terminalScreen(writes)).toBe('Failed to handle');
      stderr.write(Buffer.from('request\n'));
      expect(terminalScreen(writes)).toBe(
        'Failed to handle request\ncodex\n  still running\nharness b',
      );
      dashboard.clear();
      expect(terminalScreen(writes)).toBe('Failed to handle request');
    } finally {
      dashboard.clear();
    }
  });

  it('finishes an unterminated diagnostic before printing final output', () => {
    const {writes, stderr, dashboard} = createFixture();
    dashboard.start([{headline: 'codex\n  running'}]);
    stderr.write('proxy warning');
    dashboard.clear();
    writes.push('Finished\n');
    expect(terminalScreen(writes)).toBe('proxy warning\nFinished');
  });

  it('preserves stderr encoding, callbacks, and backpressure', async () => {
    const writes: string[] = [];
    const stderr = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        writes.push(chunk.toString());
        setImmediate(callback);
      },
    });
    const dashboard = createLiveDashboard((value) => writes.push(value), 'a', {
      stderr,
    });
    try {
      dashboard.start([{headline: 'running'}]);
      const callback = vi.fn();
      const accepted = stderr.write('7761726e696e670a', 'hex', callback);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(accepted).toBe(false);
      expect(callback).toHaveBeenCalledOnce();
      expect(terminalScreen(writes)).toBe('warning\nrunning');
    } finally {
      dashboard.clear();
    }
  });

  it('restores stderr after clearing and can start a new scenario', () => {
    const {writes, stderr, dashboard} = createFixture();
    const originalWrite = stderr.write;
    dashboard.start([{headline: 'first'}]);
    dashboard.clear();
    expect(stderr.write).toBe(originalWrite);
    stderr.write('between scenarios\n');
    dashboard.start([{headline: 'second'}]);
    stderr.write('during second\n');
    dashboard.clear();
    expect(stderr.write).toBe(originalWrite);
    expect(terminalScreen(writes)).toBe('between scenarios\nduring second');
  });
});
