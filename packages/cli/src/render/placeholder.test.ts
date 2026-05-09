import {describe, expect, it} from 'vitest';

import {stripAnsi} from '../testUtils.js';
import {renderPlaceholderMessage} from './placeholder.js';

const EXPECTED = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  This package is a placeholder. Dynobox is under active development.

  Follow along:  https://dynobox.dev
  GitHub:        https://github.com/dynobox/dynobox
`;

describe('renderPlaceholderMessage', () => {
  it('renders the placeholder banner', () => {
    expect(stripAnsi(renderPlaceholderMessage())).toBe(EXPECTED);
  });
});
