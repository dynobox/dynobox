import {tmpdir} from 'node:os';

import {describe, expect, it} from 'vitest';

import {runSetup} from './setup.js';

const workDir = tmpdir();
const env = {...process.env} as Record<string, string>;

describe('runSetup', () => {
  it('runs a single successful command', async () => {
    const result = await runSetup({
      commands: ['echo hello'],
      workDir,
      env,
    });

    expect(result.success).toBe(true);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]!.exitCode).toBe(0);
    expect(result.commands[0]!.stdout.trim()).toBe('hello');
  });

  it('runs multiple commands sequentially', async () => {
    const result = await runSetup({
      commands: ['echo first', 'echo second'],
      workDir,
      env,
    });

    expect(result.success).toBe(true);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]!.stdout.trim()).toBe('first');
    expect(result.commands[1]!.stdout.trim()).toBe('second');
  });

  it('stops at the first non-zero exit', async () => {
    const result = await runSetup({
      commands: ['echo before', 'false', 'echo after'],
      workDir,
      env,
    });

    expect(result.success).toBe(false);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]!.stdout.trim()).toBe('before');
    expect(result.commands[1]!.exitCode).not.toBe(0);
  });

  it('captures stderr on failure', async () => {
    const result = await runSetup({
      commands: ['echo oops >&2 && exit 1'],
      workDir,
      env,
    });

    expect(result.success).toBe(false);
    expect(result.commands[0]!.stderr.trim()).toBe('oops');
    expect(result.commands[0]!.exitCode).toBe(1);
  });

  it('returns success with empty commands array', async () => {
    const result = await runSetup({
      commands: [],
      workDir,
      env,
    });

    expect(result.success).toBe(true);
    expect(result.commands).toHaveLength(0);
  });

  it('records durationMs for each command', async () => {
    const result = await runSetup({
      commands: ['echo fast'],
      workDir,
      env,
    });

    expect(result.commands[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
