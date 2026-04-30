import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {FakeHarness, type ShellToolEvent} from '@dynobox/runner-local';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  configErrorExitCode,
  executeCli,
  placeholderExitCode,
  renderPlaceholderMessage,
  renderRunConfigErrorMessage,
  renderRunHeader,
  runCli,
  runFailureExitCode,
} from './index.js';

const ANSI_ESCAPE_PATTERN = /\x5B[0-9;]*m/g;
const EXPECTED_STDERR = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  This package is a placeholder. Dynobox is under active development.

  Follow along:  https://dynobox.dev
  GitHub:        https://github.com/dynobox/dynobox
`;
const FIXTURE_DIR = join(process.cwd(), '.tmp-dynobox-cli-tests');
const VALID_CONFIG_PATH = join(FIXTURE_DIR, 'valid.config.ts');
const INVALID_CONFIG_PATH = join(FIXTURE_DIR, 'invalid.config.ts');
const VALID_CONFIG = `import {defineConfig, tool} from '@dynobox/sdk';

export default defineConfig({
  name: 'cli-local-runner',
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test and summarize the result.',
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'pnpm test'}),
      ],
    },
  ],
});
`;
const INVALID_CONFIG = `export default {
  scenarios: [{name: 'missing prompt'}],
};
`;
const SHELL_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'pnpm test'},
  command: 'pnpm test',
};

function createPassingHarness(): FakeHarness {
  return new FakeHarness(undefined, {toolEvents: [SHELL_EVENT]});
}

function expectedPassingRunOutput(configPath: string): string {
  return `${renderRunHeader(configPath, 1)}[1/1] uses shell claude-code iter 1 PASS

Assertions:
PASS tool.called(shell)
PASS tool.called(shell, includes: pnpm test)
`;
}

/**
 * Removes ANSI escape sequences so test assertions can compare plain text.
 *
 * @param text The terminal output to normalize.
 * @returns The input string without ANSI escape codes.
 */
function stripAnsi(text: string): string {
  return text.replaceAll('\x1B', '').replace(ANSI_ESCAPE_PATTERN, '');
}

describe('packages/cli', () => {
  beforeAll(() => {
    rmSync(FIXTURE_DIR, {force: true, recursive: true});
    mkdirSync(FIXTURE_DIR, {recursive: true});
    writeFileSync(VALID_CONFIG_PATH, VALID_CONFIG);
    writeFileSync(INVALID_CONFIG_PATH, INVALID_CONFIG);
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, {force: true, recursive: true});
  });

  it('renders the placeholder message', () => {
    expect(stripAnsi(renderPlaceholderMessage())).toBe(EXPECTED_STDERR);
  });

  it('renders the run header', () => {
    expect(renderRunHeader('./config.ts', 2)).toBe(`dynobox run

config: ./config.ts
jobs: 2

`);
  });

  it('renders the run config error message', () => {
    expect(renderRunConfigErrorMessage('./config.ts', 'bad config')).toBe(
      `dynobox run

config: ./config.ts
error: bad config
`,
    );
  });

  it('routes no args to the placeholder message', async () => {
    await expect(executeCli([])).resolves.toEqual({
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    });
  });

  it('requires an explicit config path for run', async () => {
    const result = await executeCli(['run']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      "error: missing required argument 'config'",
    );
  });

  it('runs an explicit config path', async () => {
    await expect(
      executeCli(['run', VALID_CONFIG_PATH], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: expectedPassingRunOutput(VALID_CONFIG_PATH),
      stderr: '',
    });
  });

  it('exits nonzero when assertions fail', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH], {
      harnesses: [new FakeHarness()],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout)
      .toBe(`${renderRunHeader(VALID_CONFIG_PATH, 1)}[1/1] uses shell claude-code iter 1 FAIL

Assertions:
FAIL tool.called(shell)
FAIL tool.called(shell, includes: pnpm test)
`);
    expect(result.stderr).toBe('');
  });

  it('exits nonzero with diagnostics when local execution fails', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH], {
      harnesses: [],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout)
      .toBe(`${renderRunHeader(VALID_CONFIG_PATH, 1)}[1/1] uses shell claude-code iter 1 FAIL

Assertions:
(none)
`);
    expect(result.stderr).toBe(`Diagnostics:
scenario.uses-shell.iteration.0: No harness registered for scenario harness "claude-code".
`);
  });

  it('exits nonzero when config validation fails', async () => {
    const result = await executeCli(['run', INVALID_CONFIG_PATH]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${INVALID_CONFIG_PATH}`);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).toContain('prompt');
  });

  it('exits nonzero when config loading fails', async () => {
    const missingPath = join(FIXTURE_DIR, 'missing.config.ts');

    const result = await executeCli(['run', missingPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${missingPath}`);
    expect(result.stderr).toContain('error:');
  });

  it('rejects unknown commands', async () => {
    const result = await executeCli(['nope']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'nope'");
  });

  it('writes the placeholder message to stderr and returns the exit code', async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(runCli([])).resolves.toBe(placeholderExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stripAnsi(stderrWrite.mock.calls[0]?.[0] as string)).toBe(
      EXPECTED_STDERR,
    );

    stderrWrite.mockRestore();
  });

  it('writes run output to stdout and returns the exit code', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(
      runCli(['run', VALID_CONFIG_PATH], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toBe(0);
    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(stdoutWrite.mock.calls[0]?.[0]).toBe(
      expectedPassingRunOutput(VALID_CONFIG_PATH),
    );

    stdoutWrite.mockRestore();
  });
});
