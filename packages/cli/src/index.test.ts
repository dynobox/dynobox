import {describe, expect, it, vi} from 'vitest';

import {
  placeholderExitCode,
  renderPlaceholderMessage,
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

  it('writes the placeholder message to stderr and returns the exit code', () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(runCli()).toBe(placeholderExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stripAnsi(stderrWrite.mock.calls[0]?.[0] as string)).toBe(
      EXPECTED_STDERR,
    );

    stderrWrite.mockRestore();
  });
});
