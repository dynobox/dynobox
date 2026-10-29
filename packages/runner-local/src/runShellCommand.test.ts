import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, it, vi} from 'vitest';

import {runShellCommand} from './runShellCommand.js';

it('preserves command output and exit status', async () => {
  const result = await runShellCommand({
    command: 'printf output; printf error >&2; exit 3',
    workDir: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
  });
  expect(result.stdout).toBe('output');
  expect(result.stderr).toBe('error');
  expect(result.exitCode).toBe(3);
});

it('does not launch a command after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  const result = await runShellCommand({
    command: 'printf should-not-run',
    workDir: process.cwd(),
    env: process.env,
    signal: abort.signal,
  });
  expect(result.stdout).toBe('');
  expect(result.exitCode).not.toBe(0);
});

it.skipIf(process.platform === 'win32').each(['exit', 'SIGHUP'])(
  'stops shell commands and descendants when Dynobox exits via %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dynobox-shell-exit-'));
    const pidPath = join(root, 'pids.json');
    const commandPath = join(root, 'command.cjs');
    const ownerPath = join(root, 'owner.mjs');
    await writeFile(
      commandPath,
      `
      process.on('SIGTERM', () => {});
      if (process.argv[2] === 'child') {
        require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.ppid, process.pid]));
      } else {
        require('node:child_process').spawn(process.execPath, [__filename, 'child'], {stdio: 'inherit'});
      }
      setInterval(() => {}, 1000);
    `,
    );
    const command = [process.execPath, commandPath]
      .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
      .join(' ');
    await writeFile(
      ownerPath,
      `
      import {existsSync} from 'node:fs';
      import {runShellCommand} from ${JSON.stringify(new URL('./runShellCommand.ts', import.meta.url).href)};
      void runShellCommand({command: ${JSON.stringify(command)}, workDir: ${JSON.stringify(root)}, env: process.env, signal: new AbortController().signal});
      if (${JSON.stringify(mode)} === 'exit') setInterval(() => {
        if (existsSync(${JSON.stringify(pidPath)})) process.exit(0);
      }, 10);
    `,
    );
    const owner = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), ownerPath],
      {stdio: 'ignore'},
    );
    const exited = once(owner, 'exit');
    let pids: number[] = [];
    try {
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await readFile(pidPath, 'utf8'));
          expect(pids).toHaveLength(2);
        },
        {timeout: 5000},
      );
      if (mode === 'SIGHUP') owner.kill('SIGHUP');
      const [code, signal] = await exited;
      if (mode === 'exit') expect(code).toBe(0);
      else expect(signal).toBe('SIGHUP');
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      owner.kill('SIGKILL');
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      await exited;
      await rm(root, {recursive: true, force: true});
    }
  },
  10_000,
);
