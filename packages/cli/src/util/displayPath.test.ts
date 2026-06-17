import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {displayPath} from './displayPath.js';

describe('displayPath', () => {
  it('keeps paths inside the cwd relative even when they start with dots', () => {
    const cwd = process.cwd();
    expect(displayPath(join(cwd, '..fixtures/file.dyno.mjs'), cwd)).toBe(
      '..fixtures/file.dyno.mjs',
    );
  });

  it('keeps paths outside the cwd absolute', () => {
    const cwd = process.cwd();
    const outside = join(cwd, '..', 'outside.dyno.mjs');
    expect(displayPath(outside, cwd)).toBe(outside);
  });
});
