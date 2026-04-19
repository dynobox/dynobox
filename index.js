#!/usr/bin/env node

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;208m';
const DIM = '\x1b[2m';

console.error(`
  ${BOLD}${ORANGE}dynobox${RESET}

  Cross-harness testing for multi-step agent flows.

  ${DIM}This package is a placeholder. Dynobox is under active development.${RESET}

  Follow along:  ${ORANGE}https://dynobox.dev${RESET}
  GitHub:        ${ORANGE}https://github.com/dynobox/dynobox${RESET}
`);

process.exit(1);
