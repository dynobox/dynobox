import {describe, expect, it} from 'vitest';

import {stripAnsi} from '../testUtils.js';
import {renderPlaceholderMessage} from './placeholder.js';

const EXPECTED = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  Try \`dynobox init\` to create a starter dyno, or \`dynobox run --help\`.

  Follow along:  https://dynobox.xyz
  GitHub:        https://github.com/dynobox/dynobox
`;

describe('renderPlaceholderMessage', () => {
  it('renders the placeholder banner', () => {
    expect(stripAnsi(renderPlaceholderMessage())).toBe(EXPECTED);
  });
});
