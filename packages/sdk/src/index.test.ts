import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {describe, expect, expectTypeOf, it} from 'vitest';

import {compile, DynoboxConfigError, resolveConfigModule} from './compiler.js';
import {
  anyOf,
  type AnyOfAssertion,
  artifact,
  type ArtifactContainsAssertion,
  type ArtifactExistsAssertion,
  type ArtifactNotExistsAssertion,
  type ArtifactUnchangedAssertion,
  type CalledAssertion,
  command,
  type CommandCalledAssertion,
  type CommandNotCalledAssertion,
  defineDyno,
  defineScenario,
  dyno,
  finalMessage,
  type FinalMessageContainsAssertion,
  http,
  type PermissionMode,
  sequence,
  type SequenceInOrderAssertion,
  skill,
  type SkillReferencedAssertion,
  tool,
  type ToolCalledAssertion,
  type ToolNotCalledAssertion,
  transcript,
  type TranscriptContainsAssertion,
  verify,
  type VerifyCommandAssertion,
} from './index.js';
import {IR_VERSION, irSchema} from './ir.js';

describe('packages/sdk', () => {
  it('exports the SDK surface', () => {
    expect(typeof defineDyno).toBe('function');
    expect(typeof defineScenario).toBe('function');
    expect(typeof dyno.fromUrl).toBe('function');
    expect(typeof dyno.fsPath).toBe('function');
    expect(typeof dyno.here).toBe('function');
    expect(typeof dyno.q).toBe('function');
    expect(typeof dyno.shellQuote).toBe('function');
    expect(typeof compile).toBe('function');
    expect(typeof resolveConfigModule).toBe('function');
    expect(typeof http.endpoint).toBe('function');
    expect(typeof http.called).toBe('function');
    expect(typeof http.notCalled).toBe('function');
    expect(typeof command.called).toBe('function');
    expect(typeof command.notCalled).toBe('function');
    expect(typeof tool.called).toBe('function');
    expect(typeof tool.notCalled).toBe('function');
    expect(typeof artifact.exists).toBe('function');
    expect(typeof artifact.notExists).toBe('function');
    expect(typeof artifact.contains).toBe('function');
    expect(typeof artifact.unchanged).toBe('function');
    expect(typeof transcript.contains).toBe('function');
    expect(typeof finalMessage.contains).toBe('function');
    expect(typeof sequence.inOrder).toBe('function');
    expect(typeof anyOf).toBe('function');
    expect(typeof skill.referenced).toBe('function');
    expect(typeof verify.command).toBe('function');
    expect(typeof verify.succeeds).toBe('function');
  });

  it('provides dyno config path and shell quoting helpers', () => {
    expect(
      dyno.fromUrl('file:///tmp/dyno/test.dyno.mjs', 'fixtures/repo/'),
    ).toBe('/tmp/dyno/fixtures/repo/');
    expect(dyno.fsPath(new URL('file:///tmp/dyno/fixtures%20repo/'))).toBe(
      '/tmp/dyno/fixtures repo/',
    );
    const here = dyno.here('file:///tmp/dyno/test.dyno.mjs');
    expect(here.path('fixtures/repo/')).toBe('/tmp/dyno/fixtures/repo/');
    expect(here.q('fixtures/repo/.')).toBe("'/tmp/dyno/fixtures/repo/.'");
    expect(here.fixtures()).toBe('/tmp/dyno/fixtures');
    expect(here.fixtures('repo')).toBe('/tmp/dyno/fixtures/repo');
    expect(here.fixtures('fixtures')).toBe('/tmp/dyno/fixtures/fixtures');
    expect(dyno.shellQuote('/tmp/path with spaces')).toBe(
      "'/tmp/path with spaces'",
    );
    expect(dyno.q('/tmp/path with spaces')).toBe("'/tmp/path with spaces'");
    expect(dyno.shellQuote('')).toBe("''");
    expect(dyno.shellQuote("Bob's repo")).toBe("'Bob'\\''s repo'");
    expect(dyno.shellQuote('$(rm -rf .) $HOME `pwd`')).toBe(
      "'$(rm -rf .) $HOME `pwd`'",
    );
  });

  it('defineDyno attaches adjacent fixtures from the config module by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-fixtures-'));
    try {
      mkdirSync(join(dir, 'fixtures'), {recursive: true});
      writeFileSync(join(dir, 'fixtures', 'input.txt'), 'fixture');
      const sdkUrl = pathToFileURL(join(process.cwd(), 'src/index.ts')).href;
      const configPath = join(dir, 'fixture-config.mjs');
      writeFileSync(
        configPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  scenarios: [
    {name: 'auto fixtures', prompt: 'p'},
    {name: 'explicit fixtures', prompt: 'p', fixtures: 'custom-fixtures'},
  ],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(configPath).href}?t=${Date.now()}`
      );

      expect(mod.default.scenarios[0].fixtures).toBe(join(dir, 'fixtures'));
      expect(mod.default.scenarios[1].fixtures).toBe('custom-fixtures');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('defineDyno copies skill instructions for dynos inside .agents/skills', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-skill-'));
    try {
      const skillDir = join(dir, '.agents', 'skills', 'commit');
      const dynoDir = join(skillDir, 'dyno');
      mkdirSync(dynoDir, {recursive: true});
      writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
      const sdkUrl = pathToFileURL(join(process.cwd(), 'src/index.ts')).href;
      const configPath = join(dynoDir, 'commit.dyno.mjs');
      writeFileSync(
        configPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  setup: ['echo author setup'],
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(configPath).href}?t=${Date.now()}`
      );

      expect(mod.default.setup).toEqual(['echo author setup']);
      expect(mod.default.scenarios[0].setup).toEqual([
        "mkdir -p '.agents/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
        ),
        "mkdir -p '.claude/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
        ),
      ]);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('defineDyno preserves skill setup when imported scenarios are spread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-skill-'));
    try {
      const skillDir = join(dir, '.agents', 'skills', 'commit');
      const dynoDir = join(skillDir, 'dyno');
      mkdirSync(dynoDir, {recursive: true});
      writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
      const sdkUrl = pathToFileURL(join(process.cwd(), 'src/index.ts')).href;
      const childConfigPath = join(dynoDir, 'commit.dyno.mjs');
      const parentConfigPath = join(dir, 'skillTests.dyno.mjs');
      writeFileSync(
        childConfigPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
      );
      writeFileSync(
        parentConfigPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};
import commitSkillConfig from './.agents/skills/commit/dyno/commit.dyno.mjs';

export default defineDyno({
  scenarios: [...commitSkillConfig.scenarios],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(parentConfigPath).href}?t=${Date.now()}`
      );

      expect(mod.default.scenarios[0].setup).toEqual([
        "mkdir -p '.agents/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
        ),
        "mkdir -p '.claude/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
        ),
      ]);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('defineDyno copies claude skill instructions from matching skill roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-claude-skill-'));
    try {
      const skillDir = join(dir, '.claude', 'skills', 'commit');
      const dynoDir = join(skillDir, 'dyno');
      mkdirSync(dynoDir, {recursive: true});
      writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
      const sdkUrl = pathToFileURL(join(process.cwd(), 'src/index.ts')).href;
      const configPath = join(dynoDir, 'commit.dyno.mjs');
      writeFileSync(
        configPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(configPath).href}?t=${Date.now()}`
      );

      expect(mod.default.scenarios[0].setup).toEqual([
        "mkdir -p '.claude/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.claude\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
        ),
        "mkdir -p '.agents/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.claude\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
        ),
      ]);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('defineDyno applies authoring defaults when loaded from an npx cache path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-npx-'));
    try {
      const projectDir = join(dir, 'project');
      const sdkDir = join(
        dir,
        '.npm',
        '_npx',
        'cache-entry',
        'node_modules',
        '@dynobox',
        'sdk',
      );
      const sdkDistDir = join(sdkDir, 'dist');
      mkdirSync(sdkDistDir, {recursive: true});
      writeFileSync(join(sdkDir, 'package.json'), '{"type":"module"}\n');
      copyFileSync(
        join(process.cwd(), 'dist', 'index.js'),
        join(sdkDistDir, 'index.js'),
      );

      const skillDir = join(projectDir, '.agents', 'skills', 'commit');
      const dynoDir = join(skillDir, 'dyno');
      mkdirSync(join(dynoDir, 'fixtures'), {recursive: true});
      writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
      writeFileSync(join(dynoDir, 'fixtures', 'README.md'), '# Fixture');

      const sdkUrl = pathToFileURL(join(sdkDistDir, 'index.js')).href;
      const configPath = join(dynoDir, 'commit.dyno.mjs');
      writeFileSync(
        configPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(configPath).href}?t=${Date.now()}`
      );

      expect(mod.default.scenarios[0].fixtures).toBe(join(dynoDir, 'fixtures'));
      expect(mod.default.scenarios[0].setup).toEqual([
        "mkdir -p '.agents/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
        ),
        "mkdir -p '.claude/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
        ),
      ]);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('defineDyno applies authoring defaults when the SDK is loaded through a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dynobox-sdk-symlink-'));
    try {
      const projectDir = join(dir, 'project');
      const realSdkDir = join(dir, 'store', 'node_modules', '@dynobox', 'sdk');
      const linkSdkDir = join(projectDir, 'node_modules', '@dynobox', 'sdk');
      const realDistDir = join(realSdkDir, 'dist');
      mkdirSync(realDistDir, {recursive: true});
      mkdirSync(join(linkSdkDir, '..'), {recursive: true});
      writeFileSync(join(realSdkDir, 'package.json'), '{"type":"module"}\n');
      copyFileSync(
        join(process.cwd(), 'dist', 'index.js'),
        join(realDistDir, 'index.js'),
      );
      symlinkSync(realSdkDir, linkSdkDir);

      const skillDir = join(projectDir, '.agents', 'skills', 'commit');
      const dynoDir = join(skillDir, 'dyno');
      mkdirSync(join(dynoDir, 'fixtures'), {recursive: true});
      writeFileSync(join(skillDir, 'SKILL.md'), '# Commit skill');
      writeFileSync(join(dynoDir, 'fixtures', 'README.md'), '# Fixture');

      const sdkUrl = pathToFileURL(join(linkSdkDir, 'dist', 'index.js')).href;
      const configPath = join(dynoDir, 'commit.dyno.mjs');
      writeFileSync(
        configPath,
        `import {defineDyno} from ${JSON.stringify(sdkUrl)};

export default defineDyno({
  scenarios: [{name: 'commit skill', prompt: 'p'}],
});
`,
      );

      const mod = await import(
        `${pathToFileURL(configPath).href}?t=${Date.now()}`
      );

      expect(mod.default.scenarios[0].fixtures).toBe(join(dynoDir, 'fixtures'));
      expect(mod.default.scenarios[0].setup).toEqual([
        "mkdir -p '.agents/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.agents\/skills\/commit\/SKILL\.md'$/u,
        ),
        "mkdir -p '.claude/skills/commit'",
        expect.stringMatching(
          /^cp '.*\/\.agents\/skills\/commit\/SKILL\.md' '\.claude\/skills\/commit\/SKILL\.md'$/u,
        ),
      ]);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  it('preserves the endpoint key as a literal type on assertion helpers', () => {
    const a = http.called('getUser');
    expectTypeOf(a).toEqualTypeOf<CalledAssertion<'getUser'>>();
    expectTypeOf(a.endpoint).toEqualTypeOf<'getUser'>();
  });

  it('preserves the tool kind as a literal type on assertion helpers', () => {
    const a = tool.called('shell', {includes: 'pnpm test'});
    expectTypeOf(a).toEqualTypeOf<ToolCalledAssertion<'shell'>>();
    expectTypeOf(a.tool).toEqualTypeOf<'shell'>();
  });

  it('preserves the tool kind as a literal type on negative tool helpers', () => {
    const a = tool.notCalled('shell', {includes: 'npm publish'});
    expectTypeOf(a).toEqualTypeOf<ToolNotCalledAssertion<'shell'>>();
    expectTypeOf(a.tool).toEqualTypeOf<'shell'>();
  });

  it('types command assertion helpers', () => {
    expectTypeOf(
      command.called('git', {args: ['status']}),
    ).toEqualTypeOf<CommandCalledAssertion>();
    expectTypeOf(
      command.notCalled('git', {argsInOrder: ['push', 'origin']}),
    ).toEqualTypeOf<CommandNotCalledAssertion>();
    expectTypeOf(
      verify.command('dynobox validate out.dyno.ts', {exitCode: 0}),
    ).toEqualTypeOf<VerifyCommandAssertion>();
    expectTypeOf(
      verify.succeeds('dynobox validate out.dyno.ts'),
    ).toEqualTypeOf<VerifyCommandAssertion>();
  });

  it('types non-tool assertion helpers', () => {
    expectTypeOf(
      artifact.exists('CHANGELOG.md'),
    ).toEqualTypeOf<ArtifactExistsAssertion>();
    expectTypeOf(
      artifact.notExists('scratch.tmp'),
    ).toEqualTypeOf<ArtifactNotExistsAssertion>();
    expectTypeOf(
      artifact.contains('CHANGELOG.md', 'dynobox@0.0.4'),
    ).toEqualTypeOf<ArtifactContainsAssertion>();
    expectTypeOf(
      artifact.unchanged('package.json'),
    ).toEqualTypeOf<ArtifactUnchangedAssertion>();
    expectTypeOf(
      transcript.contains('EOTP'),
    ).toEqualTypeOf<TranscriptContainsAssertion>();
    expectTypeOf(
      finalMessage.contains('dirty'),
    ).toEqualTypeOf<FinalMessageContainsAssertion>();
    expectTypeOf(
      sequence.inOrder([tool.called('shell')]),
    ).toEqualTypeOf<SequenceInOrderAssertion>();
    expectTypeOf(
      anyOf([tool.called('shell'), command.called('git')]),
    ).toEqualTypeOf<AnyOfAssertion>();
    expectTypeOf(
      anyOf([http.called('getUser'), tool.called('shell')]),
    ).toEqualTypeOf<AnyOfAssertion<'getUser'>>();
    expectTypeOf(
      anyOf([
        artifact.exists('out.txt'),
        verify.succeeds('dynobox validate out.dyno.ts'),
      ]),
    ).toEqualTypeOf<AnyOfAssertion>();
    // @ts-expect-error sequence.inOrder cannot be evaluated inside anyOf.
    anyOf([sequence.inOrder([tool.called('shell')])]);
    // @ts-expect-error anyOf cannot be evaluated inside sequence.inOrder.
    sequence.inOrder([anyOf([tool.called('shell')])]);
    expectTypeOf(
      skill.referenced('commit'),
    ).toEqualTypeOf<SkillReferencedAssertion>();
  });

  it('compile returns a deterministic IR for a minimal config', () => {
    const config = defineDyno({
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
    expect(scenario.harnesses).toEqual([{id: 'claude-code'}]);
    expect(scenario.endpoints[0]!.id).toBe('endpoint.happy-path.getUser');
    expect(scenario.assertions[0]).toMatchObject({
      id: 'assertion.happy-path.0',
      type: 'http.called',
      endpointId: 'endpoint.happy-path.getUser',
      status: 200,
    });

    // Re-running compile produces identical IDs.
    expect(compile(config)).toEqual(ir);
  });

  it('validates compiled output against the canonical IR schema', () => {
    const config = defineDyno({
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

  it('accepts codex as a scenario harnesses entry', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'codex path',
          prompt: 'Run pnpm test.',
          harnesses: ['codex'],
        },
      ],
    });

    expect(compile(config).scenarios[0]!.harnesses).toEqual([{id: 'codex'}]);
  });

  it('accepts opencode as a scenario harnesses entry', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'opencode path',
          prompt: 'Run pnpm test.',
          harnesses: ['opencode'],
        },
      ],
    });

    expect(compile(config).scenarios[0]!.harnesses).toEqual([{id: 'opencode'}]);
  });

  it('accepts harness model config entries', () => {
    const config = defineDyno({
      harnesses: [{id: 'claude-code', model: 'sonnet'}],
      scenarios: [
        {
          name: 'codex path',
          prompt: 'Run pnpm test.',
          harnesses: [{id: 'codex', model: 'gpt-5'}],
        },
      ],
    });

    expect(compile(config).scenarios[0]!.harnesses).toEqual([
      {id: 'codex', model: 'gpt-5'},
    ]);
  });

  it('accepts harness permission mode config entries', () => {
    const mode: PermissionMode = 'dangerous';
    const config = defineDyno({
      harnesses: [{id: 'claude-code', permissionMode: 'default'}],
      scenarios: [
        {
          name: 'dangerous path',
          prompt: 'Run pnpm test.',
          harnesses: [{id: 'codex', model: 'gpt-5', permissionMode: mode}],
        },
      ],
    });

    expect(compile(config).scenarios[0]!.harnesses).toEqual([
      {id: 'codex', model: 'gpt-5', permissionMode: 'dangerous'},
    ]);
  });

  it('compiles tool assertions to canonical IR', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'uses shell',
          prompt: 'Run pnpm test.',
          assertions: [
            tool.called('shell'),
            tool.called('shell', {includes: 'pnpm test'}),
            tool.called('read_file', {path: 'README.md'}),
            tool.called('edit_file'),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.uses-shell.0',
        type: 'tool.called',
        tool: 'shell',
      },
      {
        id: 'assertion.uses-shell.1',
        type: 'tool.called',
        tool: 'shell',
        command: {includes: 'pnpm test'},
      },
      {
        id: 'assertion.uses-shell.2',
        type: 'tool.called',
        tool: 'read_file',
        path: 'README.md',
      },
      {
        id: 'assertion.uses-shell.3',
        type: 'tool.called',
        tool: 'edit_file',
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('compiles command assertions to canonical IR', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'uses commands',
          prompt: 'Check git status.',
          assertions: [
            command.called('git', {
              args: ['status'],
              argsMatching: [/^--short$/],
            }),
            command.notCalled('git', {args: ['push']}),
            sequence.inOrder([
              command.called('git', {args: ['status']}),
              command.called('git', {argsInOrder: ['add', 'README.md']}),
            ]),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.uses-commands.0',
        type: 'command.called',
        executable: 'git',
        command: {
          args: ['status'],
          argsMatching: [{source: '^--short$', flags: ''}],
        },
      },
      {
        id: 'assertion.uses-commands.1',
        type: 'command.notCalled',
        executable: 'git',
        command: {args: ['push']},
      },
      {
        id: 'assertion.uses-commands.2',
        type: 'sequence.inOrder',
        steps: [
          {
            type: 'command.called',
            executable: 'git',
            command: {args: ['status']},
          },
          {
            type: 'command.called',
            executable: 'git',
            command: {argsInOrder: ['add', 'README.md']},
          },
        ],
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('compiles anyOf assertions to flat canonical IR', () => {
    const config = defineDyno({
      endpoints: {
        package: http.endpoint({
          method: 'GET',
          url: 'https://registry.npmjs.org/dynobox',
        }),
      },
      scenarios: [
        {
          name: 'flexible file read',
          prompt: 'Read package.json.',
          assertions: [
            anyOf([
              http.called('package'),
              tool.called('read_file', {path: 'package.json'}),
              command.called('cat', {args: ['package.json']}),
            ]),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.flexible-file-read.0',
        type: 'anyOf',
        steps: [
          {
            type: 'http.called',
            endpointId: 'endpoint.flexible-file-read.package',
          },
          {
            type: 'tool.called',
            tool: 'read_file',
            path: 'package.json',
          },
          {
            type: 'command.called',
            executable: 'cat',
            command: {args: ['package.json']},
          },
        ],
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('compiles verification and new artifact branches inside anyOf', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'flexible verification',
          prompt: 'Create or validate a file.',
          assertions: [
            anyOf([
              artifact.exists('created.txt'),
              artifact.notExists('scratch.tmp'),
              artifact.unchanged('package.json'),
              verify.succeeds('dynobox validate out.dyno.ts'),
            ]),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.flexible-verification.0',
        type: 'anyOf',
        steps: [
          {type: 'artifact.exists', path: 'created.txt'},
          {type: 'artifact.notExists', path: 'scratch.tmp'},
          {type: 'artifact.unchanged', path: 'package.json'},
          {
            type: 'verify.command',
            command: 'dynobox validate out.dyno.ts',
            exitCode: 0,
          },
        ],
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('rejects unsupported assertions inside anyOf and sequence.inOrder', () => {
    expect(() =>
      compile({
        scenarios: [
          {
            name: 'unsupported sequence branch',
            prompt: 'Create a file.',
            assertions: [
              {
                type: 'anyOf',
                steps: [
                  {
                    type: 'sequence.inOrder',
                    steps: [{type: 'tool.called', tool: 'shell'}],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof compile>[0]),
    ).toThrow();

    expect(() =>
      compile({
        scenarios: [
          {
            name: 'unsupported nested anyOf branch',
            prompt: 'Create a file.',
            assertions: [
              {
                type: 'anyOf',
                steps: [
                  {
                    type: 'anyOf',
                    steps: [{type: 'tool.called', tool: 'shell'}],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof compile>[0]),
    ).toThrow();

    expect(() =>
      compile({
        scenarios: [
          {
            name: 'unsupported anyOf sequence step',
            prompt: 'Create a file.',
            assertions: [
              {
                type: 'sequence.inOrder',
                steps: [
                  {
                    type: 'anyOf',
                    steps: [{type: 'tool.called', tool: 'shell'}],
                  },
                ],
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof compile>[0]),
    ).toThrow();

    expect(() =>
      irSchema.parse({
        version: IR_VERSION,
        scenarios: [
          {
            id: 'scenario.unsupported-anyof-sequence-step',
            name: 'unsupported anyOf sequence step',
            prompt: 'Create a file.',
            harnesses: [{id: 'claude-code'}],
            setup: [],
            fixtures: [],
            endpoints: [],
            assertions: [
              {
                id: 'assertion.unsupported-anyof-sequence-step.0',
                type: 'sequence.inOrder',
                steps: [
                  {
                    type: 'anyOf',
                    steps: [{type: 'tool.called', tool: 'shell'}],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects id and label on anyOf branches', () => {
    expect(() =>
      compile({
        scenarios: [
          {
            name: 'labeled branch',
            prompt: 'Read a file.',
            assertions: [
              {
                type: 'anyOf',
                steps: [
                  {type: 'artifact.exists', path: 'a.txt', label: 'first'},
                ],
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof compile>[0]),
    ).toThrow();

    expect(() =>
      compile({
        scenarios: [
          {
            name: 'identified branch',
            prompt: 'Read a file.',
            assertions: [
              {
                type: 'anyOf',
                steps: [
                  {type: 'artifact.exists', path: 'a.txt', id: 'branch.0'},
                ],
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof compile>[0]),
    ).toThrow();
  });

  it('compiles verify command assertions to canonical IR', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'verifies output',
          prompt: 'Create a dyno.',
          assertions: [
            verify.succeeds('dynobox validate out.dyno.ts'),
            verify.command('tsc --noEmit out.ts', {
              exitCode: 0,
              stdout: {includes: 'valid'},
              stderr: {matches: '0 errors'},
            }),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.verifies-output.0',
        type: 'verify.command',
        command: 'dynobox validate out.dyno.ts',
        exitCode: 0,
      },
      {
        id: 'assertion.verifies-output.1',
        type: 'verify.command',
        command: 'tsc --noEmit out.ts',
        exitCode: 0,
        stdout: {includes: 'valid'},
        stderr: {matches: '0 errors'},
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('rejects IR verify command assertions without an explicit check', () => {
    expect(() =>
      irSchema.parse({
        version: IR_VERSION,
        scenarios: [
          {
            id: 'scenario.verifies-output',
            name: 'verifies output',
            prompt: 'Create a dyno.',
            harnesses: [{id: 'claude-code'}],
            setup: [],
            fixtures: [],
            endpoints: [],
            assertions: [
              {
                id: 'assertion.verifies-output.0',
                type: 'verify.command',
                command: 'false',
              },
            ],
          },
        ],
      }),
    ).toThrow(/Verify command assertions must specify/);
  });

  it('compiles additional assertion helpers to canonical IR', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'skill flow',
          prompt: 'Test a skill.',
          assertions: [
            tool.notCalled('shell', {includes: 'git push'}),
            tool.notCalled('read_file', {path: 'secrets.txt'}),
            artifact.exists('CHANGELOG.md'),
            artifact.contains('CHANGELOG.md', 'dynobox@0.0.4'),
            transcript.contains('EOTP'),
            finalMessage.contains('working tree is dirty'),
            sequence.inOrder([
              tool.called('shell', {includes: 'git status'}),
              tool.called('read_file', {path: 'package.json'}),
              tool.called('shell', {includes: 'git commit'}),
            ]),
            skill.referenced('commit'),
          ],
        },
      ],
    });

    const ir = compile(config);

    expect(ir.scenarios[0]!.assertions).toEqual([
      {
        id: 'assertion.skill-flow.0',
        type: 'tool.notCalled',
        tool: 'shell',
        command: {includes: 'git push'},
      },
      {
        id: 'assertion.skill-flow.1',
        type: 'tool.notCalled',
        tool: 'read_file',
        path: 'secrets.txt',
      },
      {
        id: 'assertion.skill-flow.2',
        type: 'artifact.exists',
        path: 'CHANGELOG.md',
      },
      {
        id: 'assertion.skill-flow.3',
        type: 'artifact.contains',
        path: 'CHANGELOG.md',
        text: 'dynobox@0.0.4',
      },
      {
        id: 'assertion.skill-flow.4',
        type: 'transcript.contains',
        text: 'EOTP',
      },
      {
        id: 'assertion.skill-flow.5',
        type: 'finalMessage.contains',
        text: 'working tree is dirty',
      },
      {
        id: 'assertion.skill-flow.6',
        type: 'sequence.inOrder',
        steps: [
          {
            type: 'tool.called',
            tool: 'shell',
            command: {includes: 'git status'},
          },
          {
            type: 'tool.called',
            tool: 'read_file',
            path: 'package.json',
          },
          {
            type: 'tool.called',
            tool: 'shell',
            command: {includes: 'git commit'},
          },
        ],
      },
      {
        id: 'assertion.skill-flow.7',
        type: 'skill.referenced',
        skill: 'commit',
      },
    ]);
    expect(irSchema.parse(ir)).toEqual(ir);
  });

  it('compiles plain authoring objects with the same shape as YAML', () => {
    const config = {
      scenarios: [
        {
          id: 'yaml-shaped',
          name: 'yaml shaped',
          prompt: 'Read package.json.',
          assertions: [
            {
              id: 'reads-package',
              label: 'reads package.json',
              type: 'tool.called',
              tool: 'shell',
              command: {includes: 'package.json'},
            },
            {
              type: 'artifact.contains',
              path: 'package.json',
              text: 'vitest',
            },
            {
              type: 'verify.command',
              command: 'node --version',
              exitCode: 0,
              stdout: {startsWith: 'v'},
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(compile(config).scenarios[0]).toMatchObject({
      id: 'scenario.yaml-shaped',
      assertions: [
        {
          id: 'assertion.yaml-shaped.reads-package',
          label: 'reads package.json',
          type: 'tool.called',
          tool: 'shell',
          command: {includes: 'package.json'},
        },
        {
          id: 'assertion.yaml-shaped.1',
          type: 'artifact.contains',
        },
        {
          id: 'assertion.yaml-shaped.2',
          type: 'verify.command',
          command: 'node --version',
          exitCode: 0,
          stdout: {startsWith: 'v'},
        },
      ],
    });
  });

  it('rejects legacy authoring assertion fields', () => {
    const bad = {
      scenarios: [
        {
          name: 'legacy fields',
          prompt: 'p',
          assertions: [
            {
              kind: 'tool.called',
              toolKind: 'shell',
              matcher: {includes: 'package.json'},
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/type/);
  });

  it('rejects duplicate authored ids', () => {
    const duplicateScenarios = {
      scenarios: [
        {id: 'same', name: 'first', prompt: 'p'},
        {id: 'same', name: 'second', prompt: 'p'},
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(duplicateScenarios)).toThrow(
      /Duplicate scenario id "same"/,
    );

    const duplicateAssertions = {
      scenarios: [
        {
          name: 'assertion ids',
          prompt: 'p',
          assertions: [
            {id: 'same', type: 'tool.called', tool: 'shell'},
            {id: 'same', type: 'tool.notCalled', tool: 'edit_file'},
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(duplicateAssertions)).toThrow(
      /Duplicate assertion id "same"/,
    );
  });

  it('rejects invalid tool kinds in runtime config validation', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad tool kind',
          prompt: 'p',
          assertions: [{type: 'tool.called', tool: 'not_real'}],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/Invalid option/);
  });

  it('rejects invalid shell command matcher shapes in runtime config validation', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad shell matcher',
          prompt: 'p',
          assertions: [
            {
              type: 'tool.called',
              tool: 'shell',
              command: {contains: 'pnpm'},
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/Shell command matcher/);
  });

  it('rejects shell command matchers on non-shell tool assertions', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad non-shell matcher',
          prompt: 'p',
          assertions: [
            {
              type: 'tool.called',
              tool: 'edit_file',
              command: {includes: 'src/index.ts'},
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(
      /Shell command matchers are only supported/,
    );
  });

  it('rejects shell command matchers on non-shell negative tool assertions', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad non-shell negative matcher',
          prompt: 'p',
          assertions: [
            {
              type: 'tool.notCalled',
              tool: 'edit_file',
              command: {includes: 'src/index.ts'},
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(
      /Shell command matchers are only supported/,
    );
  });

  it('rejects path matchers on non-file tool assertions', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad path matcher',
          prompt: 'p',
          assertions: [
            {
              type: 'tool.called',
              tool: 'web_search',
              path: 'README.md',
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/Path matchers/);
  });

  it('rejects unsupported sequence child assertion kinds', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad sequence child',
          prompt: 'p',
          assertions: [
            {
              type: 'sequence.inOrder',
              steps: [{type: 'artifact.exists', path: 'CHANGELOG.md'}],
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/tool.called|Invalid/);
  });

  it('rejects malformed canonical IR shapes', () => {
    const result = irSchema.safeParse({
      version: '0.1',
      scenarios: [],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected malformed IR to fail');

    const paths = new Set(result.error.issues.map((issue) => issue.path[0]));
    expect(paths.has('version')).toBe(true);
    expect(paths.has('scenarios')).toBe(true);
  });

  it('reports each invalid anyOf branch field once', () => {
    const result = irSchema.safeParse({
      version: IR_VERSION,
      scenarios: [
        {
          id: 'scenario.invalid-anyof',
          name: 'invalid anyOf',
          prompt: 'p',
          harnesses: [{id: 'claude-code'}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [
            {
              id: 'assertion.invalid-anyof.0',
              type: 'anyOf',
              steps: [
                {
                  type: 'tool.called',
                  tool: 'read_file',
                  command: {includes: 'package.json'},
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid IR to fail');
    expect(
      result.error.issues.filter(
        (issue) =>
          issue.path.join('.') === 'scenarios.0.assertions.0.steps.0.command',
      ),
    ).toHaveLength(1);
  });

  it('compiles a sample npm package research config to canonical IR', () => {
    const config = defineDyno({
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
                "status": 200,
                "type": "http.called",
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
            "fixtures": [],
            "harnesses": [
              {
                "id": "claude-code",
              },
            ],
            "id": "scenario.lookup-package-metadata",
            "name": "lookup package metadata",
            "prompt": "Find the latest published version of the npm package prettier and tell me its license.",
            "setup": [],
          },
          {
            "assertions": [
              {
                "endpointId": "endpoint.avoid-unrelated-lookup.getLeftPadMetadata",
                "id": "assertion.avoid-unrelated-lookup.0",
                "type": "http.notCalled",
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
            "fixtures": [],
            "harnesses": [
              {
                "id": "claude-code",
              },
            ],
            "id": "scenario.avoid-unrelated-lookup",
            "name": "avoid unrelated lookup",
            "prompt": "Find the latest published version of prettier. Do not look up unrelated packages.",
            "setup": [],
          },
          {
            "assertions": [
              {
                "endpointId": "endpoint.compare-two-packages.getPrettierMetadata",
                "id": "assertion.compare-two-packages.0",
                "status": 200,
                "type": "http.called",
              },
              {
                "endpointId": "endpoint.compare-two-packages.getTypescriptMetadata",
                "id": "assertion.compare-two-packages.1",
                "status": 200,
                "type": "http.called",
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
            "fixtures": [],
            "harnesses": [
              {
                "id": "claude-code",
              },
            ],
            "id": "scenario.compare-two-packages",
            "name": "compare two packages",
            "prompt": "Compare the latest versions of prettier and typescript.",
            "setup": [],
          },
        ],
        "version": "0.3",
      }
    `);
  });

  it('merges global and per-scenario endpoints, with local taking precedence', () => {
    const config = defineDyno({
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
    expect(
      scenario.assertions.map((a) => {
        if (a.type !== 'http.called' && a.type !== 'http.notCalled') {
          throw new Error('Unexpected non-HTTP assertion');
        }
        return a.endpointId;
      }),
    ).toEqual([
      'endpoint.admin-path.getUser',
      'endpoint.admin-path.deleteUser',
    ]);
  });

  it('compiles global and scenario setup commands into a merged array', () => {
    const config = defineDyno({
      setup: ['git clone https://example.com/repo.git .'],
      scenarios: [
        {
          name: 'with local setup',
          prompt: 'p',
          setup: ['npm install'],
        },
      ],
    });

    const ir = compile(config);
    expect(ir.scenarios[0]!.setup).toEqual([
      'git clone https://example.com/repo.git .',
      'npm install',
    ]);
  });

  it('compiles global-only setup into each scenario', () => {
    const config = defineDyno({
      setup: ['npm install'],
      scenarios: [
        {name: 'a', prompt: 'p'},
        {name: 'b', prompt: 'q'},
      ],
    });

    const ir = compile(config);
    expect(ir.scenarios[0]!.setup).toEqual(['npm install']);
    expect(ir.scenarios[1]!.setup).toEqual(['npm install']);
  });

  it('compiles scenario-only setup without global', () => {
    const config = defineDyno({
      scenarios: [
        {
          name: 'local only',
          prompt: 'p',
          setup: ['echo hello'],
        },
      ],
    });

    const ir = compile(config);
    expect(ir.scenarios[0]!.setup).toEqual(['echo hello']);
  });

  it('produces an empty setup array when setup is omitted', () => {
    const config = defineDyno({
      scenarios: [{name: 'no setup', prompt: 'p'}],
    });

    const ir = compile(config);
    expect(ir.scenarios[0]!.setup).toEqual([]);
  });

  it('disambiguates colliding scenario slugs deterministically', () => {
    const config = defineDyno({
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

  it('rejects endpoint keys that are unsafe for stable IR ids', () => {
    const bad = {
      scenarios: [
        {
          name: 'bad endpoint key',
          prompt: 'p',
          endpoints: {
            'get user': http.endpoint({method: 'GET', url: 'https://a/'}),
          },
        },
      ],
    } as Parameters<typeof compile>[0];

    expect(() => compile(bad)).toThrow(/Endpoint keys may only contain/);
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
    const scenario = defineScenario<'globalA'>({
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
  function _typeCheck() {
    defineDyno({
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
    defineDyno({
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

    defineDyno({
      endpoints: {
        getUser: http.endpoint({method: 'GET', url: 'https://a/'}),
      },
      scenarios: [
        {
          name: 's',
          prompt: 'p',
          assertions: [anyOf([http.called('getUser'), tool.called('shell')])],
        },
      ],
    });

    defineDyno({
      endpoints: {
        getUser: http.endpoint({method: 'GET', url: 'https://a/'}),
      },
      scenarios: [
        {
          name: 's',
          prompt: 'p',
          // @ts-expect-error 'getuser' is not in the declared endpoint key set 'getUser'
          assertions: [anyOf([http.called('getuser'), tool.called('shell')])],
        },
      ],
    });

    // Tool assertions are endpoint-independent, but shell command matchers only
    // apply to the canonical shell tool kind.
    defineDyno({
      scenarios: [
        {
          name: 'tools',
          prompt: 'p',
          assertions: [
            tool.called('shell'),
            tool.called('shell', {includes: 'pnpm test'}),
            tool.called('read_file', {path: 'package.json'}),
            tool.called('edit_file'),
            tool.notCalled('shell', {includes: 'git push'}),
            tool.notCalled('read_file', {path: 'secrets.txt'}),
            artifact.exists('CHANGELOG.md'),
            artifact.contains('CHANGELOG.md', 'dynobox@0.0.4'),
            transcript.contains('EOTP'),
            finalMessage.contains('dirty'),
            sequence.inOrder([tool.called('shell', {includes: 'git status'})]),
          ],
        },
      ],
    });

    // @ts-expect-error shell command matchers are only valid for tool.called('shell', matcher)
    tool.called('edit_file', {includes: 'src/index.ts'});

    // @ts-expect-error shell command matchers are only valid for tool.notCalled('shell', matcher)
    tool.notCalled('edit_file', {includes: 'src/index.ts'});

    // @ts-expect-error path matchers are only valid for file-oriented tools
    tool.called('web_search', {path: 'src/index.ts'});

    // @ts-expect-error sequence.inOrder v0 only accepts tool.called steps
    sequence.inOrder([artifact.exists('CHANGELOG.md')]);

    // @ts-expect-error invalid tool kinds are rejected at authoring time
    tool.called('not_real');
  }
});
