import {afterEach, expect, it, vi} from 'vitest';

import {cancelProcessGroupOnAbort, startOwnedProcess} from './processGroup.js';

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
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

it.skipIf(process.platform === 'win32').each(['timeout', 'stop', 'exit'])(
  'stops descendants with open pipes on %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dynobox-owned-process-'));
    const pidPath = join(root, 'child.pid');
    const descendant = `process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
      setInterval(() => {}, 1000);`;
    const child = startOwnedProcess(process.execPath, ['-e', parent], {
      cwd: root,
      env: process.env,
      reject: false,
      timeout: mode === 'timeout' ? 1000 : 5000,
    });
    let childPid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          childPid = Number(await readFile(pidPath, 'utf8'));
          expect(childPid).toBeGreaterThan(0);
        },
        {timeout: 2000},
      );
      if (mode === 'stop') child.stop();
      if (mode === 'exit') child.kill();
      const result = await child;
      expect(result.failed).toBe(true);
      await vi.waitFor(() =>
        expect(() => process.kill(childPid!, 0)).toThrow(),
      );
    } finally {
      child.stop();
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      await child;
      await rm(root, {recursive: true, force: true});
    }
  },
);
