import {expect, it, vi} from 'vitest';

import {awaitMcpPreparation, requireMcpVersion} from './errors.js';

it('reports a version probe timeout even when it printed a supported version', () => {
  expect(() =>
    requireMcpVersion('Claude Code', '2.1.263', {
      failed: true,
      timedOut: true,
      stdout: '2.1.263',
    }),
  ).toThrow(
    expect.objectContaining({
      category: 'timed_out',
      message: 'Claude Code version check exceeded its timeout.',
    }),
  );
});

it.each(['2.1.262', 'unreadable'])(
  'still rejects an unsupported version: %s',
  (stdout) => {
    expect(() =>
      requireMcpVersion('Claude Code', '2.1.263', {
        failed: false,
        timedOut: false,
        stdout,
      }),
    ).toThrow(expect.objectContaining({category: 'unsupported_version'}));
  },
);

it('returns prepared output and removes the cancellation listener', async () => {
  const abort = new AbortController();
  const remove = vi.spyOn(abort.signal, 'removeEventListener');
  const prepared = {};
  expect(
    await awaitMcpPreparation(async () => prepared, 1000, abort.signal),
  ).toBe(prepared);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('preserves preparation errors and removes the cancellation listener', async () => {
  const abort = new AbortController();
  const remove = vi.spyOn(abort.signal, 'removeEventListener');
  const failure = new Error('preparation failed');
  await expect(
    awaitMcpPreparation(() => Promise.reject(failure), 1000, abort.signal),
  ).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('does not start preparation after cancellation', async () => {
  const abort = new AbortController();
  const failure = new Error('cancelled');
  abort.abort(failure);
  const prepare = vi.fn(async () => ({}));
  await expect(
    awaitMcpPreparation(prepare, undefined, abort.signal),
  ).rejects.toBe(failure);
  expect(prepare).not.toHaveBeenCalled();
});

it('aborts the preparation signal when its budget expires', async () => {
  let prepareSignal: AbortSignal | undefined;
  await expect(
    awaitMcpPreparation((signal) => {
      prepareSignal = signal;
      return new Promise<never>(() => {});
    }, 10),
  ).rejects.toThrow('MCP run exceeded its timeout.');
  expect(prepareSignal?.aborted).toBe(true);
});
