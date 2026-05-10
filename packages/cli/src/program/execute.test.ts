import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {renderRunHeader} from '../render/header.js';
import {renderPlaceholderMessage} from '../render/placeholder.js';
import {
  createFixtureSet,
  createPassingHarness,
  stripAnsi,
} from '../testUtils.js';
import {executeCli, placeholderExitCode, runCli} from './execute.js';

const fixtures = createFixtureSet('execute');

const EXPECTED_PLACEHOLDER = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  This package is a placeholder. Dynobox is under active development.

  Follow along:  https://dynobox.dev
  GitHub:        https://github.com/dynobox/dynobox
`;

function expectedPassingRunHeader(configPath: string): string {
  return renderRunHeader(configPath, [
    {
      id: 'scenario.uses-shell.iteration.0',
      iteration: 0,
      harness: 'claude-code',
      scenario: {
        id: 'scenario.uses-shell',
        name: 'uses shell',
        prompt: 'Run pnpm test and summarize the result.',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        endpoints: [],
        assertions: [],
      },
    },
  ]);
}

describe('executeCli — top-level entry', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('routes no args to the placeholder message', async () => {
    await expect(executeCli([])).resolves.toEqual({
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    });
  });

  it('reports no dynos found when run is given an empty directory', async () => {
    const emptyDir = join(
      process.cwd(),
      '.tmp-dynobox-cli-tests-execute-empty',
    );
    rmSync(emptyDir, {force: true, recursive: true});
    mkdirSync(emptyDir, {recursive: true});

    try {
      const result = await executeCli(['run', emptyDir]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No *.dyno');
    } finally {
      rmSync(emptyDir, {force: true, recursive: true});
    }
  });

  it('rejects unknown commands', async () => {
    const result = await executeCli(['nope']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'nope'");
  });
});

describe('runCli — process.stdout/stderr wiring', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('writes the placeholder message to stderr and returns the exit code', async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(runCli([])).resolves.toBe(placeholderExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stripAnsi(stderrWrite.mock.calls[0]?.[0] as string)).toBe(
      EXPECTED_PLACEHOLDER,
    );

    stderrWrite.mockRestore();
  });

  it('writes run output to stdout and returns the exit code', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(
      runCli(['run', fixtures.validConfigPath], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toBe(0);
    expect(stdoutWrite.mock.calls.map((call) => call[0]).join('')).toContain(
      expectedPassingRunHeader(fixtures.validConfigPath),
    );

    stdoutWrite.mockRestore();
  });
});
