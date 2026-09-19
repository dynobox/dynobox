import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  prepareOpenCodeMcpConfiguration,
  runOpenCodeWithMcp,
} from './opencodeMcp.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-mcp-'));
  roots.push(root);
  const executable = join(root, 'opencode.mjs');
  const log = join(root, 'probes.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.DXB_TEST_MODE;
appendFileSync(process.env.DXB_TEST_LOG, JSON.stringify({args, cwd: process.cwd(), noProxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY, marker: process.env.DXB_TEST_MARKER}) + '\\n');
if (mode === 'hang') {setInterval(() => {}, 1000);}
else if (args.includes('--version')) console.log(mode === 'version' ? '9.9.9' : '1.18.26');
else {
  const config = {mcp: {linear: {type: 'local', command: ['real-server'], environment: {SECRET: 'PRIVATE_SENTINEL'}}, unrelated: {type: 'remote', url: 'https://private.invalid/PRIVATE_SENTINEL', headers: {Authorization: 'PRIVATE_SENTINEL'}}}};
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  config.permission = inline.permission || {};
  for (const [name, entry] of Object.entries(inline.mcp || {})) config.mcp[name] = {...config.mcp[name], ...entry};
  const injected = Object.keys(config.mcp).find(name => name.startsWith('dxb_'));
  if (injected && mode === 'managed') config.mcp.unrelated.enabled = true;
  if (injected && mode === 'credential') config.mcp[injected].headers = {Authorization: 'PRIVATE_SENTINEL'};
  if (injected && mode === 'missing') delete config.mcp[injected];
  if (mode === 'malformed') console.log('PRIVATE_SENTINEL invalid JSON');
  else console.log(JSON.stringify(config));
}
`,
    {mode: 0o700},
  );
  const options = {
    executable,
    input: {
      workDir: root,
      timeoutMs: 5000,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        DXB_TEST_MODE: mode,
        DXB_TEST_LOG: log,
        DXB_TEST_MARKER: 'preserved',
        NO_PROXY: 'one.example',
        no_proxy: 'two.example',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: 'example/model',
          permission: {edit: 'deny'},
          mcp: {inline: {type: 'local', command: ['inline-server']}},
        }),
      },
    },
    servers: {
      linear: {
        url: `http://127.0.0.1:12345/${'a'.repeat(48)}`,
        tools: ['get_issue'],
      },
    },
  };
  return {options, log};
}

describe('OpenCode MCP configuration preparation', () => {
  it.each(['--attach', '--dir', '--agent', '--continue', '--session'])(
    'rejects invocation escapes before any probe: %s',
    async (arg) => {
      const {options, log} = await fixture();
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, prompt: 'OK'},
          extraArgs: [arg, 'unexpected'],
        }),
      ).rejects.toMatchObject({category: 'configuration_failed'});
      await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('maps explicit grants to aliases without changing unrelated denials', async () => {
    const {options} = await fixture();
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input: {
        ...options.input,
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    const alias = Object.keys(prepared.logicalNames)[0]!;
    expect(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    ).toEqual({edit: 'deny', [`${alias}_get_issue`]: 'allow'});
    expect(prepared.denials).toContainEqual({
      permission: 'edit',
      pattern: '*',
      action: 'deny',
    });
  });
  it('disables inherited sources, injects clean aliases and preserves unrelated inline settings', async () => {
    const {options, log} = await fixture();
    const original = structuredClone(options);
    const prepared = await prepareOpenCodeMcpConfiguration(options);
    expect(options).toEqual(original);
    expect(prepared.args).toEqual(['--pure']);
    expect(prepared.version).toBe('1.18.26');
    const aliases = Object.keys(prepared.logicalNames);
    expect(aliases).toHaveLength(1);
    expect(prepared.logicalNames[aliases[0]!]).toBe('linear');
    expect(aliases[0]).toMatch(/^dxb_[a-f0-9]{24}$/);
    const overlay = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    expect(overlay.model).toBe('example/model');
    expect(overlay.permission).toEqual({edit: 'deny'});
    expect(overlay.mcp.linear).toEqual({enabled: false});
    expect(overlay.mcp.unrelated).toEqual({enabled: false});
    expect(overlay.mcp.inline).toEqual({
      type: 'local',
      command: ['inline-server'],
      enabled: false,
    });
    expect(overlay.mcp[aliases[0]!]).toEqual({
      type: 'remote',
      url: options.servers.linear.url,
      enabled: true,
      oauth: false,
      timeout: 10_000,
    });
    const probes = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(probes.map((probe) => probe.args)).toEqual([
      ['--pure', '--version'],
      ['--pure', 'debug', 'config'],
      ['--pure', 'debug', 'config'],
    ]);
    for (const probe of probes) {
      expect(probe.cwd).toBe(prepared.cwd);
      expect(probe.marker).toBe('preserved');
      expect(probe.noProxy).toBe(probe.NO_PROXY);
      expect(probe.NO_PROXY.split(',')).toEqual([
        'one.example',
        'two.example',
        '127.0.0.1',
        'localhost',
        '::1',
      ]);
    }
  });

  it.each(['managed', 'credential', 'missing', 'malformed'])(
    'fails closed on %s config without leaking raw details',
    async (mode) => {
      const {options} = await fixture(mode);
      const error = await prepareOpenCodeMcpConfiguration(options).catch(
        (value: unknown) => value,
      );
      expect(error).toMatchObject({category: 'configuration_failed'});
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
      expect(String(error)).not.toContain(options.servers.linear.url);
    },
  );

  it('rejects unknown CLI versions', async () => {
    const {options} = await fixture('version');
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'unsupported_version',
    });
  });

  it.each([
    'https://real.invalid/mcp',
    'http://localhost:1234/mcp',
    `http://127.0.0.1:1234/${'a'.repeat(48)}?secret=PRIVATE_SENTINEL`,
  ])('rejects non-controller URLs: %s', async (url) => {
    const {options} = await fixture();
    options.servers.linear.url = url;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'configuration_failed',
    });
  });

  it('keeps concurrent preparations independent', async () => {
    const {options} = await fixture();
    const [first, second] = await Promise.all([
      prepareOpenCodeMcpConfiguration(options),
      prepareOpenCodeMcpConfiguration(options),
    ]);
    expect(Object.keys(first.logicalNames)).not.toEqual(
      Object.keys(second.logicalNames),
    );
    expect(first.env.OPENCODE_CONFIG_CONTENT).not.toBe(
      second.env.OPENCODE_CONFIG_CONTENT,
    );
  });

  it('bounds hanging probes by the invocation deadline', async () => {
    const {options} = await fixture('hang');
    options.input.timeoutMs = 100;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'execution_failed',
    });
  });

  it('rejects cancellation before launching probes', async () => {
    const {options, log} = await fixture();
    await expect(
      prepareOpenCodeMcpConfiguration({
        ...options,
        input: {...options.input, signal: AbortSignal.abort()},
      }),
    ).rejects.toMatchObject({category: 'execution_failed'});
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

const nativeExecutable = process.env.DYNOBOX_OPENCODE_MCP_EXECUTABLE;
describe.skipIf(nativeExecutable === undefined)(
  'native OpenCode MCP configuration gate (no model requests)',
  () => {
    it.each([true, false])(
      'resolves the overlay and checks config side effects (authored schema: %s)',
      async (withSchema) => {
        const {options} = await fixture();
        const configPath = join(options.input.workDir, 'opencode.json');
        const source = JSON.stringify({
          ...(withSchema ? {$schema: 'https://opencode.ai/config.json'} : {}),
          mcp: {
            linear: {type: 'local', command: [process.execPath, '--version']},
            unrelated: {type: 'remote', url: 'http://127.0.0.1:1/mcp'},
          },
        });
        await writeFile(configPath, source);
        const pending = prepareOpenCodeMcpConfiguration({
          ...options,
          executable: nativeExecutable!,
          input: {
            ...options.input,
            timeoutMs: 10_000,
            env: {
              HOME: options.input.workDir,
              XDG_CONFIG_HOME: join(options.input.workDir, 'config'),
              XDG_DATA_HOME: join(options.input.workDir, 'data'),
              XDG_CACHE_HOME: join(options.input.workDir, 'cache'),
              XDG_STATE_HOME: join(options.input.workDir, 'state'),
              OPENCODE_CONFIG: configPath,
              OPENCODE_CONFIG_DIR: options.input.workDir,
              OPENCODE_CONFIG_CONTENT: '{}',
              OPENCODE_DISABLE_MODELS_FETCH: 'true',
            },
          },
        });
        if (withSchema)
          expect(Object.values((await pending).logicalNames)).toEqual([
            'linear',
          ]);
        else
          await expect(pending).rejects.toMatchObject({
            category: 'configuration_failed',
          });
        expect(await readFile(configPath, 'utf8')).toBe(source);
      },
    );
  },
);
