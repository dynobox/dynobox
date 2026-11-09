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

import {runJob} from '../index.js';
import {startMcpMockController} from '../mcpMocks/controller.js';
import * as processGroup from '../processGroup.js';
import type {LocalRunnerJob} from '../runTypes.js';
import {CodexHarness} from './codex.js';
import {runCodexWithMcp} from './codexMcp.js';
import type {ToolEvent} from './types.js';

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!executable)('native Codex MCP gates', () => {
  it('keeps transport errors logical in callbacks and extraction, with raw native debug output', async () => {
    const f = await nativeFixture('call');
    f.mode = 'transport-error';
    const events: ToolEvent[] = [];
    const run = await f.mockRun(undefined, (event) => events.push(event));
    expect(events.length).toBeGreaterThan(0);
    expect(run.toolEvents).toEqual(events);
    expect(new CodexHarness().extractResult(run.output).toolEvents).toEqual(
      events,
    );
    for (const event of events) {
      expect(event).toMatchObject({
        rawName: 'mcp__service__lookup',
        status: 'failure',
      });
      expect(event.message).toContain('service/lookup');
      expect(event.message).not.toContain('service_dynobox');
    }
    expect(run.output.stdout).toContain('service_dynobox');
    expect(
      (
        await f.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        })
      ).calls,
    ).toEqual([]);
  }, 30000);

  it.each(['call', 'negative'] as const)(
    'runs %s through the public runner with logical MCP assertion names',
    async (mode) => {
      const f = await nativeFixture(mode);
      const job: LocalRunnerJob = {
        id: 'native-codex',
        harness: 'codex',
        permissionMode: 'default',
        iteration: 0,
        scenario: {
          id: 'receipt',
          name: 'Read a receipt',
          prompt: 'Use service lookup once, then reply OK.',
          harnesses: [{id: 'codex'}],
          setup: [],
          fixtures: [],
          cliMocks: {},
          endpoints: [],
          mcpMocks: {
            service: {
              tools: {
                lookup: {
                  inputSchema: {
                    type: 'object',
                    properties: {key: {type: 'string'}},
                  },
                  response: {
                    content: [{type: 'text', text: 'MCP_FIXTURE_RECEIPT'}],
                  },
                },
              },
            },
          },
          assertions: [
            {
              id: 'receipt',
              type: mode === 'call' ? 'mcp.called' : 'mcp.notCalled',
              server: 'service',
              tool: 'lookup',
            },
          ],
        },
      };
      const tools: string[] = [];
      for (const [key, value] of Object.entries(f.env))
        if (value === undefined) vi.stubEnv(key, undefined);
      const result = await runJob(job, {
        harnesses: [
          new CodexHarness({
            executable: executable!,
            extraArgs: ['--ephemeral'],
          }),
        ],
        scratchRoot: f.root,
        env: Object.fromEntries(
          Object.entries(f.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        timeoutMs: 20000,
        onProgress: (event) => {
          if (event.type === 'harness.tool')
            tools.push(event.toolEvent.rawName);
        },
      });
      expect(result.status, result.diagnostics.join('\n')).toBe('passed');
      expect(result.mcp).toMatchObject({
        ready: true,
        finalized: true,
        failures: [],
      });
      expect(result.mcp?.calls).toHaveLength(mode === 'call' ? 1 : 0);
      expect(tools).toEqual(mode === 'call' ? ['mcp__service__lookup'] : []);
    },
    30000,
  );

  it('replaces an inherited HTTP target without credentials or preflight discovery', async () => {
    const f = await nativeFixture('call');
    const original = `${await readFile(f.configFile, 'utf8')}\n[mcp_servers.service]\nurl=${JSON.stringify(f.sentinelUrl + '/original-target')}\n[mcp_servers.service.http_headers]\nx-original="synthetic-service-credential"\n`;
    await writeFile(f.configFile, original);
    const start = processGroup.startOwnedProcess;
    vi.spyOn(processGroup, 'startOwnedProcess').mockImplementation(
      (command, args, options) => {
        f.phase = args[0] === 'exec' ? 'task' : 'metadata';
        return start(command, args, options);
      },
    );
    const run = await f.mockRun();
    expect(run.toolEvents).toContainEqual(
      expect.objectContaining({
        rawName: 'mcp__service__lookup',
        status: 'success',
      }),
    );
    expect(f.mockContacts.length).toBeGreaterThan(0);
    expect(
      f.mockContacts.every(
        (contact) => contact.phase === 'task' && !contact.inherited,
      ),
    ).toBe(true);
    expect(f.httpSources()).not.toContain('/original-target');
    expect(await readFile(f.configFile, 'utf8')).toBe(original);
  }, 30000);

  it('rejects a same-named stdio target before task startup', async () => {
    const f = await nativeFixture('negative');
    await writeFile(
      f.configFile,
      `${await readFile(f.configFile, 'utf8')}\n[mcp_servers.service]\ncommand=${JSON.stringify(process.execPath)}\n`,
    );
    await expect(f.mockRun()).rejects.toMatchObject({
      category: 'configuration_failed',
      message: expect.stringContaining('HTTP MCP mock configuration'),
    });
    expect(f.requests).toEqual([]);
    expect(f.mockContacts).toEqual([]);
  }, 30000);

  it.each(['environment', 'file'] as const)(
    'uses a private native name with %s model authentication and disables the original target',
    async (auth) => {
      const f = await nativeFixture('call');
      const source = await readFile(f.configFile, 'utf8');
      const base =
        auth === 'file'
          ? source.replace(
              'env_key = "DYNOBOX_SYNTHETIC_KEY"',
              'requires_openai_auth = true',
            )
          : source;
      const original = `${base}\n[mcp_servers.service]\nurl=${JSON.stringify(f.sentinelUrl + '/original-target')}\n[mcp_servers.service.http_headers]\nx-original="synthetic-service-credential"\n`;
      await writeFile(f.configFile, original);
      if (auth === 'file')
        await writeFile(
          join(f.env.CODEX_HOME!, 'auth.json'),
          JSON.stringify({OPENAI_API_KEY: 'synthetic-api-key'}),
          {mode: 0o600},
        );
      const {output, toolEvents} = await f.mockRun();
      expect(toolEvents).toContainEqual(
        expect.objectContaining({rawName: 'mcp__service__lookup'}),
      );
      expect(f.mockContacts.every((contact) => !contact.inherited)).toBe(true);
      expect(output.exitCode, output.stderr).toBe(0);
      expect(
        await f.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        }),
      ).toMatchObject({
        ready: true,
        calls: [{server: 'service', tool: 'lookup'}],
      });
      expect(f.httpSources()).not.toContain('/original-target');
      expect(f.httpSources()).toEqual(
        expect.arrayContaining(['/user', '/plugin']),
      );
      expect(await readFile(f.marker, 'utf8')).toContain('project');
      expect(JSON.stringify(f.requests)).toContain('USER_SKILL_SENTINEL');
      expect(JSON.stringify(f.requests)).toContain('PROJECT_SKILL_SENTINEL');
      expect(JSON.stringify(f.requests)).toContain('PLUGIN_SKILL_SENTINEL');
      expect(await readFile(f.configFile, 'utf8')).toBe(original);
    },
    40_000,
  );

  it('keeps unrelated user/project/plugin servers, skills and permissions', async () => {
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
    await fixture.assertUnrelatedAvailable();
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

  it('reports a failed logical attempt without a receipt after approval refusal', async () => {
    const fixture = await nativeFixture('call');
    const result = await runCodexWithMcp({
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
    });
    expect(result.toolEvents).toContainEqual(
      expect.objectContaining({
        rawName: 'mcp__service__lookup',
        status: 'failure',
      }),
    );
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
    await fixture.assertUnrelatedAvailable();
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
      await fixture.assertUnrelatedAvailable();
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
    await fixture.assertUnrelatedAvailable();
  }, 30_000);

  it('preserves installed flat-map cached servers after marketplace metadata changes', async () => {
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
    await fixture.assertUnrelatedAvailable();
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
  }, 30_000);

  it('preserves orphaned cached plugin servers and their skills', async () => {
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
    const selective = await fixture.mockRun();
    expect(selective.harnessReady).toBe(true);
    expect(
      (
        await fixture.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        })
      ).ready,
    ).toBe(true);
    expect(JSON.stringify(fixture.requests)).toContain('PLUGIN_SKILL_SENTINEL');
    await fixture.assertUnrelatedAvailable();
  }, 30_000);
});

/** Start a local HTTP server and register its cleanup. */
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

/** Make a native Codex fixture with temporary configuration and local servers. */
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
  const state = {
    mode: initialMode as 'call' | 'negative' | 'hang' | 'transport-error',
    phase: 'unknown',
  };
  const mockContacts: {phase: string; inherited: boolean}[] = [];
  const mockUrl = await listen(
    createServer(async (request, response) => {
      mockContacts.push({
        phase: state.phase,
        inherited: !!request.headers['x-original'],
      });
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (
          state.mode === 'transport-error' &&
          request.method === 'POST' &&
          JSON.parse(Buffer.concat(chunks).toString('utf8')).method ===
            'tools/call'
        ) {
          response.writeHead(503).end();
          return;
        }
        const forwarded = await fetch(controller.urls.service!, {
          method: request.method ?? 'GET',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          ...(request.method === 'POST' ? {body: Buffer.concat(chunks)} : {}),
        });
        response.writeHead(forwarded.status, {
          'content-type':
            forwarded.headers.get('content-type') ?? 'application/json',
        });
        response.end(await forwarded.text());
      } catch {
        response.writeHead(503).end();
      }
    }),
  );
  const modelUrl = await listen(
    createServer(
      /** Return a local model response for the selected test mode. */
      async (request, response) => {
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
          const call =
            (state.mode === 'call' || state.mode === 'transport-error') &&
            !hasResult &&
            requests.length < 4;
          const offered = [
            ...(body.tools ?? []),
            ...(body.input ?? []).flatMap(
              (entry: {type?: string; tools?: unknown[]}) =>
                entry.type === 'tool_search_output' ? (entry.tools ?? []) : [],
            ),
          ].find(
            (tool: {type?: string; tools?: {name?: string}[]}) =>
              tool.type === 'namespace' &&
              tool.tools?.some((entry) => entry.name === 'lookup'),
          );
          response.writeHead(200, {'content-type': 'text/event-stream'});
          const output = call
            ? !offered &&
              !JSON.stringify(body.input).includes('tool_search_output')
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
                    namespace: offered?.name ?? 'mcp__service',
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
          event('response.output_item.added', {
            output_index: 0,
            item: output[0],
          });
          event('response.output_item.done', {
            output_index: 0,
            item: output[0],
          });
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
      },
    ),
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith('CODEX_') || key.startsWith('OPENAI_'))
        .map((key) => [key, undefined]),
    ),
    HOME: home,
    CODEX_HOME: configDir,
    DYNOBOX_SYNTHETIC_KEY: 'synthetic-api-key',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  // Keep remote marketplace synchronization out of synthetic controls too.
  const run = (args: string[], signal?: AbortSignal) =>
    execa(
      executable!,
      [
        ...guards,
        '-c',
        `openai_base_url=${JSON.stringify(modelUrl)}`,
        '-c',
        `chatgpt_base_url=${JSON.stringify(modelUrl)}`,
        ...args,
      ],
      {
        cwd: project,
        env,
        extendEnv: false,
        stdin: 'ignore',
        reject: false,
        timeout: 20_000,
        ...(signal ? {cancelSignal: signal} : {}),
      },
    );
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
    sentinelUrl,
    modelUrl,
    mockContacts,
    set phase(value: string) {
      state.phase = value;
    },
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
    assertUnrelatedAvailable: async () => {
      expect(httpSources).toEqual(new Set(['/user', '/plugin']));
      expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(
        expect.arrayContaining(['user', 'project', 'plugin']),
      );
    },
    assertOriginals: async () => {
      for (const [path, text] of originals)
        expect(await readFile(path, 'utf8')).toBe(text);
    },
    /** Run Codex with the fixture mock server and its tool grant. */
    mockRun: (signal?: AbortSignal, onToolEvent?: (event: ToolEvent) => void) =>
      runCodexWithMcp({
        executable: executable!,
        input: {
          prompt: 'Use service lookup once, then reply OK.',
          workDir: project,
          env: env as Record<string, string>,
          timeoutMs: 20_000,
          allowedMcpTools: [{server: 'service', tool: 'lookup'}],
          ...(signal ? {signal} : {}),
          ...(onToolEvent ? {onToolEvent} : {}),
        },
        servers: {
          service: {
            url: mockUrl,
            tools: ['lookup'],
            isDiscovered: () => controller.isDiscovered('service'),
          },
        },
        extraArgs: ['--ephemeral'],
      }),
  };
}

/** Convert a test configuration value to TOML text. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
