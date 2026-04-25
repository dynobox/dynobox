import {describe, expect, it} from 'vitest';

import {
  compile,
  defineConfig,
  http,
  resolveConfigModule,
  version,
} from './index.js';

describe('packages/sdk', () => {
  it('exports the scaffolded SDK surface', () => {
    expect(version).toBe('0.0.1');
    expect(typeof defineConfig).toBe('function');
    expect(typeof compile).toBe('function');
    expect(typeof resolveConfigModule).toBe('function');
    expect(typeof http.endpoint).toBe('function');
    expect(typeof http.called).toBe('function');
    expect(typeof http.notCalled).toBe('function');
  });

  it('keeps defineConfig as a typed passthrough and compile as a validated boundary', () => {
    const config = defineConfig({
      scenarios: [
        {
          name: 'happy path',
          prompt: 'say hello',
        },
      ],
    });

    expect(config).toEqual({
      scenarios: [
        {
          name: 'happy path',
          prompt: 'say hello',
        },
      ],
    });
    expect(compile(config)).toEqual(config);
  });

  it('accepts a config module with a default export', () => {
    expect(
      resolveConfigModule({
        default: {
          scenarios: [
            {
              name: 'default export',
              prompt: 'use default export',
            },
          ],
        },
      }),
    ).toEqual({
      scenarios: [
        {
          name: 'default export',
          prompt: 'use default export',
        },
      ],
    });
  });

  it('rejects config modules without a default export', () => {
    expect(() =>
      resolveConfigModule({
        config: {
          scenarios: [],
        },
      }),
    ).toThrow(/default/i);
  });

  it('rejects invalid config shapes with a useful message', () => {
    expect(() =>
      resolveConfigModule({
        default: {
          scenarios: [
            {
              name: 'missing prompt',
            },
          ],
        },
      }),
    ).toThrow(/prompt/i);
  });
});
