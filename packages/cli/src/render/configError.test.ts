import {describe, expect, it} from 'vitest';

import {renderRunConfigErrorMessage} from './configError.js';

describe('renderRunConfigErrorMessage', () => {
  it('formats the config-error stderr block', () => {
    expect(renderRunConfigErrorMessage('./config.ts', 'bad config')).toBe(
      `dynobox run

config: ./config.ts
error: bad config
`,
    );
  });
});
