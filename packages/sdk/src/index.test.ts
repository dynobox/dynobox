import {describe, expect, expectTypeOf, it} from 'vitest';

import {
  type CalledAssertion,
  compile,
  defineConfig,
  defineScenario,
  DynoboxConfigError,
  http,
  IR_VERSION,
  irSchema,
  resolveConfigModule,
  version,
} from './index.js';

describe('packages/sdk', () => {
  it('exports the SDK surface', () => {
    expect(version).toBe('0.0.1');
    expect(typeof defineConfig).toBe('function');
    expect(typeof defineScenario).toBe('function');
    expect(typeof compile).toBe('function');
    expect(typeof resolveConfigModule).toBe('function');
    expect(typeof http.endpoint).toBe('function');
    expect(typeof http.called).toBe('function');
    expect(typeof http.notCalled).toBe('function');
  });

  it('preserves the endpoint key as a literal type on assertion helpers', () => {
    const a = http.called('getUser');
    expectTypeOf(a).toEqualTypeOf<CalledAssertion<'getUser'>>();
    expectTypeOf(a.endpoint).toEqualTypeOf<'getUser'>();
  });

  it('compile returns a deterministic IR for a minimal config', () => {
    const config = defineConfig({
      name: 'demo',
      endpoints: {
        getUser: http.endpoint({
          method: 'GET',
          url: 'https://api.example.com/user',
        }),
      },
      scenarios: [
        {
          name: 'happy path',
          prompt: 'Look up user 42',
          assertions: [http.called('getUser', {status: 200})],
        },
      ],
    });

    const ir = compile(config);
    expect(ir.version).toBe(IR_VERSION);
    expect(ir.name).toBe('demo');
    expect(ir.scenarios).toHaveLength(1);
    const scenario = ir.scenarios[0]!;
    expect(scenario.id).toBe('scenario.happy-path');
    expect(scenario.harness).toBe('claude-code');
    expect(scenario.endpoints[0]!.id).toBe('endpoint.happy-path.getUser');
    expect(scenario.assertions[0]).toMatchObject({
      id: 'assertion.happy-path.0',
      kind: 'http.called',
      endpointId: 'endpoint.happy-path.getUser',
      status: 200,
    });

    // Re-running compile produces identical IDs.
    expect(compile(config)).toEqual(ir);
  });

  it('validates compiled output against the canonical IR schema', () => {
    const config = defineConfig({
      scenarios: [
        {
          name: 'schema check',
          prompt: 'Call the health check endpoint',
          endpoints: {
            health: http.endpoint({
              method: 'GET',
              url: 'https://api.example.com/health',
            }),
          },
          assertions: [http.notCalled('health')],
        },
      ],
    });

    expect(irSchema.parse(compile(config))).toEqual(compile(config));
  });

  it('rejects malformed canonical IR shapes', () => {
    const result = irSchema.safeParse({
      version: '0.2',
      scenarios: [],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected malformed IR to fail');

    const paths = new Set(result.error.issues.map((issue) => issue.path[0]));
    expect(paths.has('version')).toBe(true);
    expect(paths.has('scenarios')).toBe(true);
  });

  it('compiles a sample npm package research config to canonical IR', () => {
    const config = defineConfig({
      name: 'npm-package-research',
      endpoints: {
        getPrettierMetadata: http.endpoint({
          method: 'GET',
          url: 'https://registry.npmjs.org/prettier',
        }),
        getTypescriptMetadata: http.endpoint({
          method: 'GET',
          url: 'https://registry.npmjs.org/typescript',
        }),
        getLeftPadMetadata: http.endpoint({
          method: 'GET',
          url: 'https://registry.npmjs.org/left-pad',
        }),
      },
      scenarios: [
        {
          name: 'lookup package metadata',
          prompt:
            'Find the latest published version of the npm package prettier and tell me its license.',
          assertions: [http.called('getPrettierMetadata', {status: 200})],
        },
        {
          name: 'avoid unrelated lookup',
          prompt:
            'Find the latest published version of prettier. Do not look up unrelated packages.',
          assertions: [http.notCalled('getLeftPadMetadata')],
        },
        {
          name: 'compare two packages',
          prompt: 'Compare the latest versions of prettier and typescript.',
          assertions: [
            http.called('getPrettierMetadata', {status: 200}),
            http.called('getTypescriptMetadata', {status: 200}),
          ],
        },
      ],
    });

    expect(compile(config)).toMatchInlineSnapshot(`
      {
        "name": "npm-package-research",
        "scenarios": [
          {
            "assertions": [
              {
                "endpointId": "endpoint.lookup-package-metadata.getPrettierMetadata",
                "id": "assertion.lookup-package-metadata.0",
                "kind": "http.called",
                "status": 200,
              },
            ],
            "endpoints": [
              {
                "id": "endpoint.lookup-package-metadata.getPrettierMetadata",
                "key": "getPrettierMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/prettier",
              },
              {
                "id": "endpoint.lookup-package-metadata.getTypescriptMetadata",
                "key": "getTypescriptMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/typescript",
              },
              {
                "id": "endpoint.lookup-package-metadata.getLeftPadMetadata",
                "key": "getLeftPadMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/left-pad",
              },
            ],
            "harness": "claude-code",
            "id": "scenario.lookup-package-metadata",
            "name": "lookup package metadata",
            "prompt": "Find the latest published version of the npm package prettier and tell me its license.",
          },
          {
            "assertions": [
              {
                "endpointId": "endpoint.avoid-unrelated-lookup.getLeftPadMetadata",
                "id": "assertion.avoid-unrelated-lookup.0",
                "kind": "http.notCalled",
              },
            ],
            "endpoints": [
              {
                "id": "endpoint.avoid-unrelated-lookup.getPrettierMetadata",
                "key": "getPrettierMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/prettier",
              },
              {
                "id": "endpoint.avoid-unrelated-lookup.getTypescriptMetadata",
                "key": "getTypescriptMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/typescript",
              },
              {
                "id": "endpoint.avoid-unrelated-lookup.getLeftPadMetadata",
                "key": "getLeftPadMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/left-pad",
              },
            ],
            "harness": "claude-code",
            "id": "scenario.avoid-unrelated-lookup",
            "name": "avoid unrelated lookup",
            "prompt": "Find the latest published version of prettier. Do not look up unrelated packages.",
          },
          {
            "assertions": [
              {
                "endpointId": "endpoint.compare-two-packages.getPrettierMetadata",
                "id": "assertion.compare-two-packages.0",
                "kind": "http.called",
                "status": 200,
              },
              {
                "endpointId": "endpoint.compare-two-packages.getTypescriptMetadata",
                "id": "assertion.compare-two-packages.1",
                "kind": "http.called",
                "status": 200,
              },
            ],
            "endpoints": [
              {
                "id": "endpoint.compare-two-packages.getPrettierMetadata",
                "key": "getPrettierMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/prettier",
              },
              {
                "id": "endpoint.compare-two-packages.getTypescriptMetadata",
                "key": "getTypescriptMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/typescript",
              },
              {
                "id": "endpoint.compare-two-packages.getLeftPadMetadata",
                "key": "getLeftPadMetadata",
                "method": "GET",
                "url": "https://registry.npmjs.org/left-pad",
              },
            ],
            "harness": "claude-code",
            "id": "scenario.compare-two-packages",
            "name": "compare two packages",
            "prompt": "Compare the latest versions of prettier and typescript.",
          },
        ],
        "version": "0.1",
      }
    `);
  });

  it('merges global and per-scenario endpoints, with local taking precedence', () => {
    const config = defineConfig({
      endpoints: {
        getUser: http.endpoint({method: 'GET', url: 'https://a/'}),
      },
      scenarios: [
        {
          name: 'admin path',
          prompt: 'delete user',
          endpoints: {
            deleteUser: http.endpoint({method: 'DELETE', url: 'https://a/d'}),
          },
          assertions: [http.called('getUser'), http.called('deleteUser')],
        },
      ],
    });

    const ir = compile(config);
    const scenario = ir.scenarios[0]!;
    expect(scenario.endpoints.map((e) => e.key).sort()).toEqual([
      'deleteUser',
      'getUser',
    ]);
    expect(scenario.assertions.map((a) => a.endpointId)).toEqual([
      'endpoint.admin-path.getUser',
      'endpoint.admin-path.deleteUser',
    ]);
  });

  it('disambiguates colliding scenario slugs deterministically', () => {
    const config = defineConfig({
      scenarios: [
        {name: 'happy path', prompt: 'a'},
        {name: 'Happy Path', prompt: 'b'},
        {name: 'happy-path', prompt: 'c'},
      ],
    });
    const ir = compile(config);
    expect(ir.scenarios.map((s) => s.id)).toEqual([
      'scenario.happy-path',
      'scenario.happy-path-2',
      'scenario.happy-path-3',
    ]);
  });

  it('throws DynoboxConfigError when an assertion references an unknown endpoint', () => {
    // Bypass type-checking to simulate a runtime-only path (e.g. JS author).
    const bad = {
      scenarios: [
        {
          name: 'oops',
          prompt: 'p',
          assertions: [http.called('nope' as string)],
        },
      ],
    } as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(DynoboxConfigError);
    expect(() => compile(bad)).toThrow(/unknown endpoint "nope"/);
  });

  it('defineScenario typechecks local endpoint references', () => {
    const scenario = defineScenario({
      name: 'self-contained',
      prompt: 'p',
      endpoints: {
        ping: http.endpoint({method: 'GET', url: 'https://a/ping'}),
      },
      assertions: [http.called('ping')],
    });
    expect(scenario.name).toBe('self-contained');
  });

  it('defineScenario accepts globals via type parameter', () => {
    const scenario = defineScenario<Record<string, never>, 'globalA'>({
      name: 'uses global',
      prompt: 'p',
      assertions: [http.called('globalA')],
    });
    expect(scenario.assertions?.[0]).toMatchObject({endpoint: 'globalA'});
  });

  it('accepts a config module with a default export', () => {
    const resolved = resolveConfigModule({
      default: {
        scenarios: [{name: 'd', prompt: 'p'}],
      },
    });
    expect(resolved.scenarios).toHaveLength(1);
  });

  it('rejects config modules without a default export', () => {
    expect(() => resolveConfigModule({config: {scenarios: []}})).toThrow(
      /default/i,
    );
  });

  it('rejects invalid config shapes with a useful message', () => {
    expect(() =>
      resolveConfigModule({
        default: {scenarios: [{name: 'missing prompt'}]},
      }),
    ).toThrow(/prompt/i);
  });

  // Pure type-level smoke test: this code should not type-check if the
  // assertion key constraint is broken. Wrapped in a never-called function
  // so it has zero runtime cost but participates in `tsc`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _typeCheck() {
    defineConfig({
      endpoints: {
        getUser: http.endpoint({method: 'GET', url: 'https://a/'}),
      },
      scenarios: [
        {
          name: 's',
          prompt: 'p',
          // @ts-expect-error 'getuser' is not in the declared endpoint key set 'getUser'
          assertions: [http.called('getuser')],
        },
      ],
    });

    // Sanity: the well-typed version compiles cleanly.
    defineConfig({
      endpoints: {
        getUser: http.endpoint({method: 'GET', url: 'https://a/'}),
      },
      scenarios: [
        {
          name: 's',
          prompt: 'p',
          assertions: [http.called('getUser')],
        },
      ],
    });
  }
});
