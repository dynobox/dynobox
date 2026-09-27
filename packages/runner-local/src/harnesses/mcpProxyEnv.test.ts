import {expect, it} from 'vitest';

import {mcpProxyEnv} from './mcpProxyEnv.js';

it('preserves both proxy bypass lists and adds loopback only once', () => {
  expect(
    mcpProxyEnv({
      NO_PROXY: 'example.com,127.0.0.1',
      no_proxy: 'internal.test, example.com',
    }),
  ).toEqual({
    NO_PROXY: 'example.com,127.0.0.1,internal.test,localhost,::1',
    no_proxy: 'example.com,127.0.0.1,internal.test,localhost,::1',
  });
});
