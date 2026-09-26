import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
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
else if (args.includes('--version')) console.log(mode === 'version' ? '1.10.0' : mode === 'newer' ? '1.20.0' : '1.18.26');
else {
  const config = {mcp: {real: {type: 'local', command: ['real-server'], environment: {SECRET: 'PRIVATE_SENTINEL'}}, unrelated: {type: 'remote', url: 'https://private.invalid/PRIVATE_SENTINEL', headers: {Authorization: 'PRIVATE_SENTINEL'}}}};
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  config.permission = inline.permission || {};
  for (const [name, entry] of Object.entries(inline.mcp || {})) config.mcp[name] = {...config.mcp[name], ...entry};
  if (mode === 'exit') process.exit(2);
  console.log(JSON.stringify(config));
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
        url: 'http://127.0.0.1:12345/linear',
        tools: ['get_issue'],
      },
    },
  };
  return {options, log};
}

describe('OpenCode MCP configuration preparation', () => {
  it.each(['--attach', '--dir', '--agent', '--continue', '--session'])(
    'rejects extra arguments before any probe: %s',
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

  it('maps explicit grants without changing unrelated denials', async () => {
    const {options} = await fixture();
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input: {
        ...options.input,
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    expect(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    ).toEqual({edit: 'deny', linear_get_issue: 'allow'});
    expect(prepared.denials).toContainEqual({
      permission: 'edit',
      pattern: '*',
      action: 'deny',
    });
  });
  it('disables inherited sources and preserves unrelated inline settings', async () => {
    const {options, log} = await fixture();
    const original = structuredClone(options);
    const prepared = await prepareOpenCodeMcpConfiguration(options);
    expect(options).toEqual(original);
    expect(prepared.version).toBe('1.18.26');
    const overlay = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    expect(overlay.model).toBe('example/model');
    expect(overlay.permission).toEqual({edit: 'deny'});
    expect(overlay.mcp.real).toEqual({enabled: false});
    expect(overlay.mcp.unrelated).toEqual({enabled: false});
    expect(overlay.mcp.inline).toEqual({
      type: 'local',
      command: ['inline-server'],
      enabled: false,
    });
    expect(overlay.mcp.linear).toEqual({
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
    ]);
    for (const probe of probes) {
      expect(probe.cwd).toBe(await realpath(prepared.cwd));
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

  it.each(['real', 'inline'])(
    'fails when the config already has a server named %s',
    async (name) => {
      const {options} = await fixture();
      options.servers = {
        [name]: {url: 'http://127.0.0.1:12345/x', tools: ['search']},
      } as never;
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({
        category: 'configuration_failed',
        message: expect.stringContaining(`MCP server named "${name}"`),
      });
    },
  );

  it('reports a failed config read with the command', async () => {
    const {options} = await fixture('exit');
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'configuration_failed',
      message: 'opencode debug config exited with code 2.',
    });
  });

  it.each([
    ['version', false],
    ['newer', true],
  ])('checks the minimum CLI version (%s)', async (mode, supported) => {
    const {options} = await fixture(mode);
    const pending = prepareOpenCodeMcpConfiguration(options);
    if (supported) expect((await pending).version).toBe('1.20.0');
    else
      await expect(pending).rejects.toMatchObject({
        category: 'unsupported_version',
        message: expect.stringContaining('1.18.26 or newer'),
      });
  });

  it('bounds hanging probes by the invocation deadline', async () => {
    const {options} = await fixture('hang');
    options.input.timeoutMs = 100;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'timed_out',
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
      'resolves the overlay against real config sources (authored schema: %s)',
      async (withSchema) => {
        const {options} = await fixture();
        const configPath = join(options.input.workDir, 'opencode.json');
        const source = JSON.stringify({
          ...(withSchema ? {$schema: 'https://opencode.ai/config.json'} : {}),
          mcp: {
            real: {type: 'local', command: [process.execPath, '--version']},
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
        const prepared = await pending;
        const overlay = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
        expect(overlay.mcp.real).toEqual({enabled: false});
        expect(overlay.mcp.linear).toMatchObject({enabled: true});
        expect(overlay.mcp.unrelated).toEqual({enabled: false});
      },
    );
  },
);
