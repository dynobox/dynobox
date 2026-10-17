import {expect, it} from 'vitest';

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
