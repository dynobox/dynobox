import {describe, expect, it} from 'vitest';

import {shouldRenderLive} from './environment.js';

describe('shouldRenderLive', () => {
  it('requires ANSI-capable color output', () => {
    expect(shouldRenderLive({live: true}, {mode: 'default', color: true})).toBe(
      true,
    );
    expect(
      shouldRenderLive({live: true}, {mode: 'default', color: false}),
    ).toBe(false);
  });

  it('keeps quiet and non-live output static', () => {
    expect(shouldRenderLive({live: true}, {mode: 'quiet', color: true})).toBe(
      false,
    );
    expect(
      shouldRenderLive({live: false}, {mode: 'default', color: true}),
    ).toBe(false);
  });
});
