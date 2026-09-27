import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {runCodexWithMcp} from './codexMcp.js';

// Real CLI, synthetic profiles and local Responses fixture. No copied auth or
// paid model requests. Run with an absolute DYNOBOX_CODEX_MCP_EXECUTABLE path.
const executable = process.env.DYNOBOX_CODEX_MCP_EXECUTABLE;
const cleanups: (() => Promise<unknown>)[] = [];
const guards = [
  '--disable',
  'apps',
  '--disable',
  'remote_plugin',
  '--disable',
  'skill_mcp_dependency_install',
];
const execArgs = [
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--',
  'Reply OK.',
];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!executable)('native Codex MCP gates', () => {
  it('excludes active user/project/plugin servers and preserves skills and permissions', async () => {
    const fixture = await nativeFixture('call');
    const {output: result} = await fixture.mockRun();
    expect(result.exitCode, result.stderr).toBe(0);
    const observation = await fixture.controller.finalize({
      harnessReady: true,
      harnessSucceeded: true,
    });
    expect(observation).toMatchObject({
      ready: true,
      failures: [],
      calls: [
        {
          server: 'service',
          tool: 'lookup',
          input: {key: 'receipt'},
          category: 'success',
        },
      ],
    });
    const requests = JSON.stringify(fixture.requests);
    expect(requests).toContain('PLUGIN_SKILL_SENTINEL');
    expect(requests).toContain('PROJECT_SKILL_SENTINEL');
    expect(requests).toContain('USER_SKILL_SENTINEL');
    expect(requests).toContain('MCP_FIXTURE_RECEIPT');
    expect(requests).toContain('read-only');
    await fixture.assertNoSentinels();
    await fixture.assertOriginals();

    // Positive control: every planted source must actually start/contact.
    fixture.mode = 'negative';
    const control = await fixture.run(execArgs);
    expect(control.exitCode, control.stderr).toBe(0);
    expect((await readFile(fixture.marker, 'utf8')).trim().split('\n')).toEqual(
      expect.arrayContaining(['user', 'project', 'plugin']),
    );
    expect(fixture.httpSources()).toEqual(
      expect.arrayContaining(['/user', '/plugin']),
    );
  }, 40_000);

  it('fails a run whose mock call is refused for approval', async () => {
    const fixture = await nativeFixture('call');
    await expect(
      runCodexWithMcp({
        executable: executable!,
        input: {
          prompt: 'Use service lookup once, then reply OK.',
          workDir: fixture.project,
          env: fixture.env as Record<string, string>,
          timeoutMs: 20_000,
        },
        servers: {
          service: {url: fixture.controller.urls.service!, tools: ['lookup']},
        },
        extraArgs: ['--ephemeral'],
      }),
    ).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('mcp__service__lookup'),
    });
    const observation = await fixture.controller.finalize({
      harnessReady: true,
      harnessSucceeded: false,
    });
    expect(observation.calls).toEqual([]);
  }, 40_000);

  it('discovers mocks during a negative-only run', async () => {
    const fixture = await nativeFixture('negative');
    const {output: result} = await fixture.mockRun();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      await fixture.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      }),
    ).toMatchObject({ready: true, failures: [], calls: []});
    await fixture.assertNoSentinels();
  }, 30_000);

  it('fails a negative-only turn before model execution when required startup fails', async () => {
    const fixture = await nativeFixture('negative');
    await fixture.controller.finalize({
      harnessReady: false,
      harnessSucceeded: false,
    });
    await expect(fixture.mockRun()).rejects.toMatchObject({
      category: 'execution_failed',
    });
    expect(fixture.requests).toEqual([]);
    await fixture.assertNoSentinels();
  }, 30_000);
  it('keeps concurrent controllers independent and revokes their routes', async () => {
    const first = await nativeFixture('call');
    const second = await nativeFixture('negative');
    const results = await Promise.all([first.mockRun(), second.mockRun()]);
    for (const [index, fixture] of [first, second].entries()) {
      expect(results[index]!.output.exitCode).toBe(0);
      const observation = await fixture.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.ready).toBe(true);
      expect(observation.calls).toHaveLength(index === 0 ? 1 : 0);
      await fixture.assertNoSentinels();
      await expect(fetch(fixture.controller.urls.service!)).rejects.toThrow();
    }
  }, 30_000);

  it('cancels a native invocation after mock discovery', async () => {
    const fixture = await nativeFixture('negative');
    fixture.mode = 'hang';
    const abort = new AbortController();
    const pending = fixture.mockRun(abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      category: 'execution_failed',
    });
    await vi.waitFor(() => expect(fixture.requests.length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    abort.abort();
    await rejected;
    expect(
      (
        await fixture.controller.finalize({
          harnessReady: false,
          harnessSucceeded: false,
        })
      ).ready,
    ).toBe(false);
    await fixture.assertNoSentinels();
  }, 30_000);

  it('isolates installed flat-map cached servers after marketplace metadata changes', async () => {
    const fixture = await nativeFixture('negative', true);
    await writeFile(fixture.pluginMcp, JSON.stringify({mcpServers: {}}));
    const control = await fixture.run(execArgs);
    expect(control.exitCode).toBe(0);
    expect(await readFile(fixture.marker, 'utf8')).toContain('plugin');
    expect(fixture.httpSources()).toContain('/plugin');
    await fixture.resetSentinels();
    fixture.requests.splice(0);
    const result = await fixture.mockRun();
    expect(result.harnessReady).toBe(true);
    expect(
      (
        await fixture.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        })
      ).ready,
    ).toBe(true);
    await fixture.assertNoSentinels();
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
  }, 30_000);

  it('isolates orphaned cached plugin servers while preserving their skills', async () => {
    const fixture = await nativeFixture('negative');
    const control = await fixture.run(execArgs);
    expect(control.exitCode).toBe(0);
    expect(await readFile(fixture.marker, 'utf8')).toContain('plugin');
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
    fixture.requests.splice(0);
    await writeFile(fixture.marker, '');
    const config = await readFile(fixture.configFile, 'utf8');
    const withoutMarketplace = config.replace(
      /\[marketplaces\.fixture-market\][\s\S]*?(?=\n\[|$)/,
      '',
    );
    expect(withoutMarketplace).not.toBe(config);
    expect(withoutMarketplace).toContain('fixture@fixture-market');
    await writeFile(fixture.configFile, withoutMarketplace);
    const orphan = await fixture.run(execArgs);
    expect(orphan.exitCode).toBe(0);
    expect(await readFile(fixture.marker, 'utf8')).toContain('plugin');
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
    await fixture.resetSentinels();
    fixture.requests.splice(0);
    const isolated = await fixture.mockRun();
    expect(isolated.harnessReady).toBe(true);
    expect(
      (
        await fixture.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        })
      ).ready,
    ).toBe(true);
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
    await fixture.assertNoSentinels();
  }, 30_000);
});

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}

async function nativeFixture(
  initialMode: 'call' | 'negative',
  flatMcp = false,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dynobox-codex-native-')),
  );
  cleanups.push(() => rm(root, {recursive: true, force: true, maxRetries: 5}));
  const home = join(root, 'home');
  const configDir = join(home, '.codex');
  const project = join(root, 'project');
  const plugin = join(root, 'marketplace', 'plugin');
  const marker = join(root, 'marker');
  for (const path of [
    configDir,
    join(project, '.codex'),
    join(plugin, '.codex-plugin'),
    join(root, 'marketplace', '.agents', 'plugins'),
  ])
    await mkdir(path, {recursive: true});
  for (const [directory, label] of [
    [join(configDir, 'skills', 'user-skill'), 'USER'],
    [join(project, '.agents', 'skills', 'project-skill'), 'PROJECT'],
    [join(plugin, 'skills', 'plugin-skill'), 'PLUGIN'],
  ]) {
    await mkdir(directory!, {recursive: true});
    await writeFile(
      join(directory!, 'SKILL.md'),
      `---\nname: ${label!.toLowerCase()}-skill\ndescription: ${label}_SKILL_SENTINEL\n---\nReply OK.\n`,
    );
  }
  const sentinel = join(root, 'sentinel.mjs');
  await writeFile(
    sentinel,
    `import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[2], process.argv[3] + '\\n');`,
  );
  const stdio = (source: string) => ({
    command: process.execPath,
    args: [sentinel, marker, source],
  });
  let contacts = 0;
  const httpSources = new Set<string>();
  const sentinelUrl = await listen(
    createServer((_request, response) => {
      contacts++;
      httpSources.add(_request.url ?? '');
      response.writeHead(503).end();
    }),
  );
  const controller = await startMcpMockController({
    service: {
      tools: {
        lookup: {
          description: 'Return a receipt',
          inputSchema: {type: 'object', properties: {key: {type: 'string'}}},
          response: {content: [{type: 'text', text: 'MCP_FIXTURE_RECEIPT'}]},
        },
      },
    },
  });
  cleanups.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: unknown[] = [];
  const state = {mode: initialMode as 'call' | 'negative' | 'hang'};
  const modelUrl = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try {
        if (request.headers.authorization !== 'Bearer synthetic-api-key') {
          response.writeHead(401).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        if (state.mode === 'hang') return;
        const hasResult = JSON.stringify(body.input).includes(
          'MCP_FIXTURE_RECEIPT',
        );
        const call = state.mode === 'call' && !hasResult && requests.length < 4;
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const output = call
          ? !JSON.stringify(body.input).includes('tool_search_output')
            ? [
                {
                  id: 'ts_fixture',
                  type: 'tool_search_call',
                  call_id: 'search_fixture',
                  execution: 'client',
                  arguments: {query: 'lookup receipt', limit: 1},
                  status: 'completed',
                },
              ]
            : [
                {
                  id: 'fc_fixture',
                  type: 'function_call',
                  call_id: 'call_fixture',
                  name: 'lookup',
                  namespace: 'mcp__service',
                  arguments: '{"key":"receipt"}',
                  status: 'completed',
                },
              ]
          : [
              {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{type: 'output_text', text: 'OK', annotations: []}],
              },
            ];
        const event = (type: string, data: object) =>
          response.write(
            `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`,
          );
        event('response.created', {
          response: {
            id: 'resp_fixture',
            object: 'response',
            status: 'in_progress',
            output: [],
          },
        });
        event('response.output_item.added', {output_index: 0, item: output[0]});
        event('response.output_item.done', {output_index: 0, item: output[0]});
        event('response.completed', {
          response: {
            id: 'resp_fixture',
            object: 'response',
            status: 'completed',
            output,
            usage: {input_tokens: 100, output_tokens: 10, total_tokens: 110},
          },
        });
        response.end();
      } catch {
        response.writeHead(500).end();
      }
    }),
  );
  const configFile = join(configDir, 'config.toml');
  await writeFile(
    configFile,
    `model = "gpt-5.4"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "fixture"\nbase_url = ${JSON.stringify(modelUrl)}\nwire_api = "responses"\nenv_key = "DYNOBOX_SYNTHETIC_KEY"\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[mcp_servers.user_sentinel]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(stdio('user').args)}\nstartup_timeout_sec = 1\n[mcp_servers.inherited_http]\nurl = ${JSON.stringify(`${sentinelUrl}/user`)}\nstartup_timeout_sec = 1\n`,
  );
  await writeFile(
    join(project, '.codex', 'config.toml'),
    `mcp_servers = {project_sentinel = ${toml({...stdio('project'), startup_timeout_sec: 1})}}\n`,
  );
  await writeFile(
    join(plugin, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      description: 'Synthetic MCP fixture',
      skills: './skills/',
    }),
  );
  const pluginServers = {
    plugin_sentinel: stdio('plugin'),
    plugin_http: {type: 'http', url: `${sentinelUrl}/plugin`},
  };
  await writeFile(
    join(plugin, '.mcp.json'),
    JSON.stringify(flatMcp ? pluginServers : {mcpServers: pluginServers}),
  );
  await writeFile(
    join(root, 'marketplace', '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'fixture-market',
      interface: {displayName: 'Fixture'},
      plugins: [{name: 'fixture', source: {source: 'local', path: './plugin'}}],
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: configDir,
    DYNOBOX_SYNTHETIC_KEY: 'synthetic-api-key',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  // Keep remote marketplace synchronization out of synthetic controls too.
  const run = (args: string[], signal?: AbortSignal) =>
    execa(executable!, [...guards, ...args], {
      cwd: project,
      env,
      extendEnv: false,
      stdin: 'ignore',
      reject: false,
      timeout: 20_000,
      ...(signal ? {cancelSignal: signal} : {}),
    });
  const added = await run([
    'plugin',
    'marketplace',
    'add',
    join(root, 'marketplace'),
    '--json',
  ]);
  expect(added.exitCode, added.stderr).toBe(0);
  const installed = await run([
    'plugin',
    'add',
    'fixture@fixture-market',
    '--json',
  ]);
  expect(installed.exitCode, installed.stderr).toBe(0);
  const originals = await Promise.all(
    [
      configFile,
      join(project, '.codex', 'config.toml'),
      join(plugin, '.mcp.json'),
    ].map(async (path) => [path, await readFile(path, 'utf8')] as const),
  );
  return {
    controller,
    requests,
    root,
    project,
    marker,
    run,
    env,
    configFile,
    pluginMcp: join(plugin, '.mcp.json'),
    get mode() {
      return state.mode;
    },
    set mode(value: typeof state.mode) {
      state.mode = value;
    },
    contacts: () => contacts,
    httpSources: () => [...httpSources],
    resetSentinels: async () => {
      contacts = 0;
      httpSources.clear();
      await rm(marker, {force: true});
    },
    assertNoSentinels: async () => {
      expect(contacts).toBe(0);
      await expect(readFile(marker)).rejects.toThrow();
    },
    assertOriginals: async () => {
      for (const [path, text] of originals)
        expect(await readFile(path, 'utf8')).toBe(text);
    },
    mockRun: (signal?: AbortSignal) =>
      runCodexWithMcp({
        executable: executable!,
        input: {
          prompt: 'Use service lookup once, then reply OK.',
          workDir: project,
          env: env as Record<string, string>,
          timeoutMs: 20_000,
          allowedMcpTools: [{server: 'service', tool: 'lookup'}],
          ...(signal ? {signal} : {}),
        },
        servers: {service: {url: controller.urls.service!, tools: ['lookup']}},
        extraArgs: ['--ephemeral'],
      }),
  };
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
