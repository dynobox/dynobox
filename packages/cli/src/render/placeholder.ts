/** No-subcommand message shown when the CLI is invoked without arguments. */

import {BOLD, dim, PURPLE, RESET} from '../terminal/index.js';

export function renderPlaceholderMessage(): string {
  const dimCtx = {color: true} as const;
  return `
  ${BOLD}${PURPLE}dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${dim(dimCtx, 'Try `dynobox init` to create a starter dyno, or `dynobox run --help`.')}${RESET}

  Follow along:  ${PURPLE}https://dynobox.xyz${RESET}
  GitHub:        ${PURPLE}https://github.com/dynobox/dynobox${RESET}
`;
}
