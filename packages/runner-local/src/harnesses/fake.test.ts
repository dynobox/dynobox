import {HARNESS_IDS} from '@dynobox/sdk';
import {describe, expect, it} from 'vitest';

import {FakeHarness} from './fake.js';
import type {HarnessInput, HarnessRunOutput} from './types.js';

const input: HarnessInput = {
  prompt: 'Find the latest version of prettier.',
  workDir: '/tmp/dynobox-test',
  env: {HTTPS_PROXY: 'http://localhost:8080'},
};

describe('Harness contract (FakeHarness)', () => {
  it('has a valid harness id', () => {
    const harness = new FakeHarness();
    expect(HARNESS_IDS).toContain(harness.id);
  });

  it('run returns a valid HarnessRunOutput', async () => {
    const harness = new FakeHarness();
    const output = await harness.run(input);

    expect(typeof output.exitCode).toBe('number');
    expect(typeof output.stdout).toBe('string');
    expect(typeof output.stderr).toBe('string');
    expect(typeof output.durationMs).toBe('number');
  });

  it('extractResult produces transcript and finalMessage from stdout', () => {
    const harness = new FakeHarness();
    const raw: HarnessRunOutput = {
      exitCode: 0,
      stdout: 'The latest version is 3.5.0.',
      stderr: '',
      durationMs: 500,
    };

    const result = harness.extractResult(raw);

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(500);
    expect(result.transcript).toBe('The latest version is 3.5.0.');
    expect(result.finalMessage).toBe('The latest version is 3.5.0.');
  });

  it('extractResult returns undefined finalMessage when stdout is empty', () => {
    const harness = new FakeHarness();
    const raw: HarnessRunOutput = {
      exitCode: 1,
      stdout: '',
      stderr: 'process timed out',
      durationMs: 30000,
    };

    const result = harness.extractResult(raw);

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toBe('');
    expect(result.finalMessage).toBeUndefined();
  });

  it('returns the configured canned response from run', async () => {
    const harness = new FakeHarness({exitCode: 1, stdout: 'custom output'});
    const output = await harness.run(input);

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe('custom output');
  });
});
