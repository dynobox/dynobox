import {afterEach, expect, it, vi} from 'vitest';

import {cancelProcessGroupOnAbort} from './processGroup.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === 'win32')(
  'forces the process group to stop after cancellation',
  async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const abort = new AbortController();
    const cleanup = cancelProcessGroupOnAbort({pid: 123}, abort.signal);
    abort.abort();
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL');
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('removes the cancellation listener after normal completion', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const abort = new AbortController();
  const cleanup = cancelProcessGroupOnAbort({pid: 123}, abort.signal);
  cleanup();
  abort.abort();
  expect(kill).not.toHaveBeenCalled();
});
