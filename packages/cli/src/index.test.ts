import {describe, expect, it, vi} from 'vitest';

import {
  executeCli,
  placeholderExitCode,
  renderPlaceholderMessage,
  renderRunScaffoldMessage,
  runCli,
  runScaffoldExitCode,
} from './index.js';

const ANSI_ESCAPE_PATTERN = /\x5B[0-9;]*m/g;
const EXPECTED_STDERR = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  This package is a placeholder. Dynobox is under active development.

  Follow along:  https://dynobox.dev
  GitHub:        https://github.com/dynobox/dynobox
`;
const EXPECTED_RUN_SCAFFOLD = `dynobox run

config: ./config.ts

Config loading is not implemented yet.
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
  it('renders the placeholder message', () => {
    expect(stripAnsi(renderPlaceholderMessage())).toBe(EXPECTED_STDERR);
  });

  it('renders the run scaffold message', () => {
    expect(renderRunScaffoldMessage('./config.ts')).toBe(EXPECTED_RUN_SCAFFOLD);
  });

  it('routes no args to the placeholder message', () => {
    expect(executeCli([])).toEqual({
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    });
  });

  it('requires an explicit config path for run', () => {
    const result = executeCli(['run']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      "error: missing required argument 'config'",
    );
  });

  it('routes run with a config path to the scaffold message', () => {
    expect(executeCli(['run', './config.ts'])).toEqual({
      exitCode: runScaffoldExitCode,
      stdout: '',
      stderr: EXPECTED_RUN_SCAFFOLD,
    });
  });

  it('rejects unknown commands', () => {
    const result = executeCli(['nope']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'nope'");
  });

  it('writes the placeholder message to stderr and returns the exit code', () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(runCli([])).toBe(placeholderExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stripAnsi(stderrWrite.mock.calls[0]?.[0] as string)).toBe(
      EXPECTED_STDERR,
    );

    stderrWrite.mockRestore();
  });

  it('writes run scaffold output to stderr and returns the exit code', () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(runCli(['run', './config.ts'])).toBe(runScaffoldExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stderrWrite.mock.calls[0]?.[0]).toBe(EXPECTED_RUN_SCAFFOLD);

    stderrWrite.mockRestore();
  });
});
