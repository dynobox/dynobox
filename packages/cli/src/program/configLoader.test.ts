import {describe, expect, it} from 'vitest';

import * as configLoader from './configLoader.js';

describe('configLoader', () => {
  it('exports loadDyno without a loadConfigModule alias', () => {
    expect(configLoader.loadDyno).toBeTypeOf('function');
    expect('loadConfigModule' in configLoader).toBe(false);
  });

  it('unwraps one level of default nesting from loaded modules', () => {
    expect(
      configLoader.normalizeLoadedModule({
        default: {default: {name: 'nested'}},
      }),
    ).toEqual({
      default: {name: 'nested'},
    });
    expect(
      configLoader.normalizeLoadedModule({default: {name: 'plain'}}),
    ).toEqual({
      default: {name: 'plain'},
    });
  });
});