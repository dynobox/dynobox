/** No-subcommand message shown when the CLI is invoked without arguments. */

import {BOLD, dim, RESET} from '../terminal/index.js';

export function renderPlaceholderMessage(): string {
  const dimCtx = {color: true} as const;
  return `
  ${BOLD}■ dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${dim(dimCtx, 'Try `dynobox init` to create a starter dyno, or `dynobox run --help`.')}${RESET}

  Follow along:  https://dynobox.xyz
  GitHub:        https://github.com/dynobox/dynobox
`;
}
