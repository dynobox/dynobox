const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const PURPLE = '\x1b[38;5;141m';
const DIM = '\x1b[2m';

export const placeholderExitCode = 1;

/**
 * Renders the current placeholder CLI message with ANSI styling.
 *
 * @returns The formatted message written by the placeholder CLI.
 */
export function renderPlaceholderMessage(): string {
  return `
  ${BOLD}${PURPLE}dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${DIM}This package is a placeholder. Dynobox is under active development.${RESET}

  Follow along:  ${PURPLE}https://dynobox.dev${RESET}
  GitHub:        ${PURPLE}https://github.com/dynobox/dynobox${RESET}
`;
}

/**
 * Executes the current placeholder CLI behavior.
 *
 * @returns The exit code for the placeholder CLI process.
 */
export function runCli(): number {
  process.stderr.write(renderPlaceholderMessage());
  return placeholderExitCode;
}
