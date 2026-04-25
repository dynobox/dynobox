import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  configErrorExitCode,
  executeCli,
  placeholderExitCode,
  renderPlaceholderMessage,
  renderRunConfigErrorMessage,
  renderRunPreviewMessage,
  runCli,
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
const VALID_CONFIG = `import {defineConfig, http} from '@dynobox/sdk';

export default defineConfig({
  name: 'cli-preview',
  endpoints: {
    prettier: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/prettier',
    }),
    typescript: http.endpoint({
      method: 'GET',
      url: 'https://registry.npmjs.org/typescript',
    }),
  },
  scenarios: [
    {
      name: 'lookup package metadata',
      prompt: 'Find the latest published version of prettier.',
      assertions: [http.called('prettier', {status: 200})],
    },
    {
      name: 'compare package metadata',
      prompt: 'Compare prettier and typescript.',
      assertions: [
        http.called('prettier', {status: 200}),
        http.called('typescript', {status: 200}),
      ],
    },
  ],
});
`;
const INVALID_CONFIG = `export default {
  scenarios: [{name: 'missing prompt'}],
};
`;

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

  it('renders the run preview message', () => {
    expect(
      renderRunPreviewMessage('./config.ts', {
        scenarios: 2,
        harnesses: 1,
        assertions: 3,
      }),
    ).toBe(`dynobox run

config: ./config.ts
scenarios: 2
harnesses: 1
assertions: 3
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

  it('loads and compiles an explicit config path', async () => {
    await expect(executeCli(['run', VALID_CONFIG_PATH])).resolves.toEqual({
      exitCode: 0,
      stdout: renderRunPreviewMessage(VALID_CONFIG_PATH, {
        scenarios: 2,
        harnesses: 1,
        assertions: 3,
      }),
      stderr: '',
    });
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

  it('writes run preview output to stdout and returns the exit code', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(runCli(['run', VALID_CONFIG_PATH])).resolves.toBe(0);
    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(stdoutWrite.mock.calls[0]?.[0]).toBe(
      renderRunPreviewMessage(VALID_CONFIG_PATH, {
        scenarios: 2,
        harnesses: 1,
        assertions: 3,
      }),
    );

    stdoutWrite.mockRestore();
  });
});
