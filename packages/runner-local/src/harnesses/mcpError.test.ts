import {expect, it, vi} from 'vitest';

import {awaitMcpPreparation} from './mcpError.js';

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
