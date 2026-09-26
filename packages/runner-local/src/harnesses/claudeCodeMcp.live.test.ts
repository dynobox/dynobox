import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer, type Server, type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {
  type ClaudeCodeMcpOptions,
  runClaudeCodeWithMcp,
} from './claudeCodeMcp.js';

// Opt in with an absolute path to the candidate Claude binary. Real CLI, local
// model-response fixture, synthetic profiles only; no paid model or copied auth.
// These gates cover user/local/project/plugin sources, not cloud or managed MCP.
const executable = process.env.DYNOBOX_CLAUDE_MCP_EXECUTABLE;
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!executable)('native Claude Code MCP gates', () => {
  it('excludes active inherited sources while preserving skills and normal permissions', async () => {
    const fixture = await nativeFixture('call');
    const run = await runClaudeCodeWithMcp(fixture.options);
    const init = run.output.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'system' && event.subtype === 'init');
    expect(init.slash_commands).toContain('fixture-skill');
    expect(init.permissionMode).not.toBe('bypassPermissions');
    expect(
      fixture.requests.some((request) =>
        JSON.stringify(request).includes('MCP_SKILL_DESCRIPTION_SENTINEL'),
      ),
    ).toBe(true);
    const observation = await fixture.controller.finalize({
      harnessReady: run.harnessReady,
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
    expect(
      fixture.requests.some((request) =>
        JSON.stringify(request).includes('MCP_FIXTURE_RECEIPT'),
      ),
    ).toBe(true);
    expect(fixture.contacts()).toBe(0);
    await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
    await fixture.assertOriginals();

    // Positive control: all planted sources must actually start/contact without
    // strict mode. A silently inactive fixture cannot prove source exclusion.
    fixture.setMode('negative');
    const control = await execa(
      executable!,
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--no-session-persistence',
        '--',
        'Reply OK.',
      ],
      {
        cwd: fixture.options.input.workDir,
        env: fixture.options.input.env,
        stdin: 'ignore',
        reject: false,
        timeout: 30_000,
      },
    );
    expect(control.exitCode).toBe(0);
    const starts = (await readFile(fixture.marker, 'utf8')).trim().split('\n');
    expect(starts).toEqual(
      expect.arrayContaining(['user', 'local', 'project', 'plugin']),
    );
    expect(fixture.contacts()).toBeGreaterThan(0);
  }, 60_000);

  it('establishes readiness for a negative-only run with actual discovery', async () => {
    const fixture = await nativeFixture('negative');
    const run = await runClaudeCodeWithMcp(fixture.options);
    expect(
      await fixture.controller.finalize({
        harnessReady: run.harnessReady,
        harnessSucceeded: true,
      }),
    ).toMatchObject({ready: true, failures: [], calls: []});
    expect(fixture.contacts()).toBe(0);
    await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
  }, 30_000);

  it('preserves tool denial from normal project permissions', async () => {
    const fixture = await nativeFixture('call');
    await writeFile(
      join(fixture.options.input.workDir, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: {deny: ['mcp__service__lookup']},
      }),
    );
    await expect(runClaudeCodeWithMcp(fixture.options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    expect(
      await fixture.controller.finalize({
        harnessReady: false,
        harnessSucceeded: false,
      }),
    ).toMatchObject({ready: false, failures: ['not_ready'], calls: []});
    expect(JSON.stringify(fixture.requests)).not.toContain(
      'MCP_FIXTURE_RECEIPT',
    );
  }, 30_000);

  it('cancels a native invocation after startup', async () => {
    const fixture = await nativeFixture('negative');
    fixture.setMode('hang');
    const abort = new AbortController();
    fixture.options.input.signal = abort.signal;
    const pending = runClaudeCodeWithMcp(fixture.options);
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
    expect(fixture.contacts()).toBe(0);
    await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
  }, 30_000);

  it.each(['disconnected', 'denied'] as const)(
    'fails negative-only readiness when the mock is %s',
    async (mode) => {
      const fixture = await nativeFixture('negative', mode === 'denied');
      if (mode === 'disconnected')
        await fixture.controller.finalize({
          harnessReady: false,
          harnessSucceeded: false,
        });
      await expect(runClaudeCodeWithMcp(fixture.options)).rejects.toMatchObject(
        {category: 'not_ready'},
      );
      expect(
        (
          await fixture.controller.finalize({
            harnessReady: false,
            harnessSucceeded: false,
          })
        ).ready,
      ).toBe(false);
      expect(fixture.contacts()).toBe(0);
      await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
      await fixture.assertOriginals();
    },
    30_000,
  );

  it('keeps concurrent native invocations and receipts independent', async () => {
    const first = await nativeFixture('call', false, 'FIRST_RECEIPT');
    const second = await nativeFixture('call', false, 'SECOND_RECEIPT');
    const results = await Promise.all([
      runClaudeCodeWithMcp(first.options),
      runClaudeCodeWithMcp(second.options),
    ]);
    for (const [index, fixture] of [first, second].entries()) {
      const observation = await fixture.controller.finalize({
        harnessReady: results[index]!.harnessReady,
        harnessSucceeded: true,
      });
      expect(observation.ready).toBe(true);
      expect(observation.failures).toEqual([]);
      expect(observation.calls).toHaveLength(1);
      const requests = JSON.stringify(fixture.requests);
      expect(requests).toContain(
        index === 0 ? 'FIRST_RECEIPT' : 'SECOND_RECEIPT',
      );
      expect(requests).not.toContain(
        index === 0 ? 'SECOND_RECEIPT' : 'FIRST_RECEIPT',
      );
      expect(fixture.contacts()).toBe(0);
      await expect(readFile(fixture.marker, 'utf8')).rejects.toThrow();
      await expect(fetch(fixture.controller.urls.service!)).rejects.toThrow();
    }
  }, 30_000);
});

async function listen(server: Server): Promise<string> {
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
  if (address === null || typeof address === 'string')
    throw new Error('Listener did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function nativeFixture(
  initialMode: 'call' | 'negative',
  denied = false,
  receipt = 'MCP_FIXTURE_RECEIPT',
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dynobox-claude-native-')),
  );
  cleanups.push(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home');
  const configDir = join(home, '.claude');
  const project = join(root, 'project');
  const plugin = join(root, 'plugin');
  const marker = join(root, 'started.txt');
  const originals = new Map<string, string>();
  const write = async (path: string, data: unknown) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    await writeFile(path, text);
    originals.set(path, text);
  };
  await Promise.all([
    mkdir(join(configDir, 'plugins'), {recursive: true}),
    mkdir(join(project, '.claude', 'skills', 'fixture-skill'), {
      recursive: true,
    }),
    mkdir(join(plugin, '.claude-plugin'), {recursive: true}),
    mkdir(join(root, '.claude-plugin'), {recursive: true}),
  ]);
  const sentinel = join(root, 'sentinel.mjs');
  await write(
    sentinel,
    `import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[2], process.argv[3] + '\\n');`,
  );
  const stdio = (source: string) => ({
    type: 'stdio',
    command: process.execPath,
    args: [sentinel, marker, source],
  });
  let contacts = 0;
  const sentinelUrl = await listen(
    createServer((_request, response) => {
      contacts++;
      response.writeHead(503).end();
    }),
  );
  await write(join(configDir, '.claude.json'), {
    hasCompletedOnboarding: true,
    mcpServers: {
      user_sentinel: stdio('user'),
      inherited_http: {type: 'http', url: `${sentinelUrl}/mcp`},
    },
    projects: {
      [project]: {
        hasTrustDialogAccepted: true,
        mcpServers: {local_sentinel: stdio('local')},
      },
    },
  });
  await write(join(project, '.mcp.json'), {
    mcpServers: {project_sentinel: stdio('project')},
  });
  await write(join(plugin, '.claude-plugin', 'plugin.json'), {
    name: 'fixture-plugin',
    version: '1.0.0',
    description: 'Local MCP exclusion sentinel',
  });
  await write(join(plugin, '.mcp.json'), {
    mcpServers: {plugin_sentinel: stdio('plugin')},
  });
  await write(join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'fixture',
    owner: {name: 'Dynobox tests'},
    plugins: [{name: 'fixture-plugin', source: './plugin'}],
  });
  await write(join(configDir, 'plugins', 'known_marketplaces.json'), {
    fixture: {
      source: {source: 'directory', path: root},
      installLocation: root,
      lastUpdated: '2026-09-07T00:00:00.000Z',
    },
  });
  await write(join(configDir, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'fixture-plugin@fixture': [
        {
          scope: 'user',
          installPath: plugin,
          version: '1.0.0',
          installedAt: '2026-09-07T00:00:00.000Z',
          lastUpdated: '2026-09-07T00:00:00.000Z',
        },
      ],
    },
  });
  await write(join(configDir, 'settings.json'), {
    enabledPlugins: {'fixture-plugin@fixture': true},
  });
  await write(join(project, '.claude', 'settings.json'), {
    permissions: {allow: ['mcp__service__lookup']},
    ...(denied ? {deniedMcpServers: [{serverName: 'service'}]} : {}),
  });
  await write(
    join(project, '.claude', 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: MCP_SKILL_DESCRIPTION_SENTINEL\n---\nUse the service lookup tool.\n',
  );
  const controller = await startMcpMockController({
    service: {
      tools: {
        lookup: {
          description: 'Return a fixture receipt.',
          inputSchema: {type: 'object', properties: {key: {type: 'string'}}},
          response: {content: [{type: 'text', text: receipt}]},
        },
      },
    },
  });
  cleanups.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: unknown[] = [];
  let mode: 'call' | 'negative' | 'hang' = initialMode;
  const modelUrl = await listen(
    createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url?.includes('count_tokens')) {
          response
            .writeHead(200, {'content-type': 'application/json'})
            .end(JSON.stringify({input_tokens: 100}));
          return;
        }
        if (!request.url?.startsWith('/v1/messages')) {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.headers['x-api-key'] !== 'synthetic-api-key') {
          response.writeHead(401).end();
          return;
        }
        requests.push(body);
        if (mode === 'hang') return;
        const hasResult = body.messages?.some(
          (message: {content: unknown}) =>
            Array.isArray(message.content) &&
            message.content.some(
              (part: {type: string}) => part.type === 'tool_result',
            ),
        );
        respond(response, mode === 'call' && !hasResult, body.stream === true);
      } catch {
        response.writeHead(500).end();
      }
    }),
  );
  const options: ClaudeCodeMcpOptions = {
    executable: executable!,
    input: {
      workDir: project,
      prompt:
        'Use the service lookup tool once with key receipt, then reply OK.',
      model: 'claude-sonnet-4-5',
      timeoutMs: 25_000,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: 'synthetic-api-key',
        ANTHROPIC_BASE_URL: modelUrl,
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        MCP_TIMEOUT: '1000',
        MCP_TOOL_TIMEOUT: '1000',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    },
    extraArgs: ['--no-session-persistence'],
    servers: {service: {url: controller.urls.service!, tools: ['lookup']}},
  };
  return {
    options,
    controller,
    requests,
    marker,
    contacts: () => contacts,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    assertOriginals: async () => {
      // Claude itself can update its profile bookkeeping. Compare MCP definitions
      // semantically there; the adapter must leave installed settings/files intact.
      for (const [path, original] of originals) {
        const current = await readFile(path, 'utf8');
        if (path === join(configDir, '.claude.json')) {
          expect(JSON.parse(current).mcpServers).toEqual(
            JSON.parse(original).mcpServers,
          );
          expect(JSON.parse(current).projects[project].mcpServers).toEqual(
            JSON.parse(original).projects[project].mcpServers,
          );
        } else expect(current).toBe(original);
      }
    },
  };
}

function respond(response: ServerResponse, call: boolean, stream: boolean) {
  const block = call
    ? {
        type: 'tool_use',
        id: 'toolu_fixture',
        name: 'mcp__service__lookup',
        input: {key: 'receipt'},
      }
    : {type: 'text', text: 'OK'};
  const message = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [block],
    stop_reason: call ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {input_tokens: 100, output_tokens: 10},
  };
  if (!stream) {
    response
      .writeHead(200, {'content-type': 'application/json'})
      .end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, {'content-type': 'text/event-stream'});
  const event = (type: string, data: object) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`,
    );
  event('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: {input_tokens: 100, output_tokens: 0},
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: call ? {...block, input: {}} : {type: 'text', text: ''},
  });
  event('content_block_delta', {
    index: 0,
    delta: call
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify({key: 'receipt'}),
        }
      : {type: 'text_delta', text: 'OK'},
  });
  event('content_block_stop', {index: 0});
  event('message_delta', {
    delta: {stop_reason: message.stop_reason, stop_sequence: null},
    usage: {output_tokens: 10},
  });
  event('message_stop', {});
  response.end();
}
