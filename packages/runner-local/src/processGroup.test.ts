import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
it
  .skipIf(process.platform === 'win32')
  .each(['exit', 'exception', 'SIGHUP', 'SIGTERM', 'double-SIGINT'])(
  'stops owned processes when the owner exits via %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dynobox-owner-exit-'));
    const pidPath = join(root, 'child.pid');
    const ownerPath = join(root, 'owner.mjs');
    const pids: number[] = [];
    const descendant = `process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {}, 1000);`;
    const harness = `process.on('SIGTERM', () => {});
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'});
    setInterval(() => {}, 1000);`;
    await writeFile(
      ownerPath,
      `
    import {startOwnedProcess} from ${JSON.stringify(new URL('./processGroup.ts', import.meta.url).href)};
    import {existsSync} from 'node:fs';
    const child = startOwnedProcess(process.execPath, ['-e', ${JSON.stringify(harness)}], {
      cwd: ${JSON.stringify(root)}, env: process.env, reject: false,
    });
    if (${JSON.stringify(mode)} === 'double-SIGINT') {
      let cancelled = false;
      process.on('SIGINT', () => {
        if (cancelled) process.exit(130);
        cancelled = true;
        process.stdout.write('cancelled\\n');
      });
    }
    const ready = setInterval(() => {
      if (!existsSync(${JSON.stringify(pidPath)})) return;
      clearInterval(ready);
      process.stdout.write(String(child.pid) + '\\n');
      if (${JSON.stringify(mode)} === 'exit') process.exit(0);
      if (${JSON.stringify(mode)} === 'exception') throw new Error('owner crashed');
    }, 10);
  `,
    );
    const owner = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), ownerPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const closed = once(owner, 'close');
    let stdout = '';
    let stderr = '';
    owner.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    owner.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await vi.waitFor(() => expect(stdout).toMatch(/^\d+\n/), {timeout: 5000});
      pids.push(
        Number(stdout.split('\n')[0]),
        Number(await readFile(pidPath, 'utf8')),
      );
      if (mode === 'double-SIGINT') {
        owner.kill('SIGINT');
        await vi.waitFor(() => expect(stdout).toContain('cancelled\n'));
        expect(() => process.kill(pids[0]!, 0)).not.toThrow();
        owner.kill('SIGINT');
      } else if (mode === 'SIGHUP' || mode === 'SIGTERM') {
        owner.kill(mode);
      }
      const [code, signal] = await closed;
      if (mode === 'exit') expect(code).toBe(0);
      if (mode === 'exception') {
        expect(code).toBe(1);
        expect(stderr).toContain('owner crashed');
      }
      if (mode === 'double-SIGINT') expect(code).toBe(130);
      if (mode === 'SIGHUP' || mode === 'SIGTERM') expect(signal).toBe(mode);
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      owner.kill('SIGKILL');
      if (pids[0] !== undefined) {
        try {
          process.kill(-pids[0], 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      await closed;
      await rm(root, {recursive: true, force: true});
    }
  },
  10_000,
);
