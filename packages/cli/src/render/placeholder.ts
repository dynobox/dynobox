/**
 * "Package is a placeholder" message shown when the CLI is invoked with no
 * arguments. Branded but intentionally terse.
 */

import {BOLD, dim, PURPLE, RESET} from '../terminal/index.js';

export function renderPlaceholderMessage(): string {
  const dimCtx = {color: true} as const;
  return `
  ${BOLD}${PURPLE}dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${dim(dimCtx, 'This package is a placeholder. Dynobox is under active development.')}${RESET}

  Follow along:  ${PURPLE}https://dynobox.dev${RESET}
  GitHub:        ${PURPLE}https://github.com/dynobox/dynobox${RESET}
`;
}
