import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {AntigravityHarness} from './antigravity.js';
import {AntigravityMcpError, runAntigravityWithMcp} from './antigravityMcp.js';

const executable = process.env.DYNOBOX_ANTIGRAVITY_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(mode: 'call' | 'negative' | 'hang') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-agy-native-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const work = join(root, 'work');
  const home = join(root, 'home');
  await mkdir(work);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), {recursive: true});
  await writeFile(
    join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({modelProvider: 'gemini'}),
  );
  const controller = await startMcpMockController({
    linear: {
      tools: {
        get_issue: {
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}},
          },
          response: {content: [{type: 'text', text: 'agy-receipt-42'}]},
        },
      },
    },
  });
  cleanup.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: string[] = [];
  let deniedContacts = 0;
  const model = createServer(async (request, response) => {
    if (request.url === '/denied') {
      deniedContacts++;
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push(body);
    if (mode === 'hang') return;
    let parsed: {tools?: {functionDeclarations?: {name: string}[]}[]};
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(404).end();
      return;
    }
    const tool = parsed.tools
      ?.flatMap(
        (entry: {functionDeclarations?: {name: string}[]}) =>
          entry.functionDeclarations ?? [],
      )
      .find((entry: {name: string}) => entry.name === 'call_mcp_tool');
    const hasReceipt = body.includes('agy-receipt-42');
    const part =
      mode === 'call' && tool && !hasReceipt
        ? {
            functionCall: {
              name: 'call_mcp_tool',
              args: {
                ServerName: 'linear',
                ToolName: 'get_issue',
                Arguments: {id: 'DYNO-1'},
                toolAction: 'Reading issue',
                toolSummary: 'Issue lookup',
              },
            },
          }
        : {text: hasReceipt ? 'agy-receipt-42' : 'READY'};
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end(
      'data: ' +
        JSON.stringify({
          candidates: [
            {content: {role: 'model', parts: [part]}, finishReason: 'STOP'},
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        }) +
        '\n\n',
    );
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        model.closeAllConnections();
        model.close(() => resolve());
      }),
  );
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const base = `http://127.0.0.1:${address.port}`;
  const input = {
    workDir: work,
    env: {
      HOME: home,
      GEMINI_API_KEY: 'synthetic',
      GOOGLE_GEMINI_BASE_URL: base,
    },
    prompt:
      mode === 'call'
        ? 'Use Linear get_issue for DYNO-1. Report its exact receipt.'
        : 'Do not call tools. Reply READY.',
    model: 'Gemini 3.8 Flash (Low)',
    permissionMode: 'dangerous' as const,
    timeoutMs: 20000,
  };
  const options = {
    executable: executable!,
    input,
    servers: {linear: {url: controller.urls.linear!, tools: ['get_issue']}},
  };
  return {
    root,
    home,
    work,
    controller,
    options,
    requests,
    deniedUrl: base + '/denied',
    deniedContacts: () => deniedContacts,
  };
}

describe.skipIf(!executable)('native Antigravity MCP runtime', () => {
  it.each(['call', 'negative'] as const)(
    'runs %s with a synthetic model',
    async (mode) => {
      const f = await fixture(mode);
      const result = await runAntigravityWithMcp(f.options);
      const observation = await f.controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      expect(observation).toMatchObject({
        ready: true,
        finalized: true,
        failures: [],
      });
      expect(observation.calls).toHaveLength(mode === 'call' ? 1 : 0);
      expect(
        new AntigravityHarness().extractResult(result.output).finalMessage,
      ).toContain(mode === 'call' ? 'agy-receipt-42' : 'READY');
      expect(f.requests.length).toBeGreaterThan(0);
      await expect(
        readFile(join(f.work, '.agents', 'mcp_config.json')),
      ).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('runs a mock call with a scoped normal-permission grant', async () => {
    const f = await fixture('call');
    const result = await runAntigravityWithMcp({
      ...f.options,
      input: {
        ...f.options.input,
        permissionMode: 'default',
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    const observation = await f.controller.finalize({
      harnessReady: result.harnessReady,
      harnessSucceeded: true,
    });
    expect(observation).toMatchObject({ready: true, failures: []});
    expect(observation.calls).toHaveLength(1);
    expect(
      new AntigravityHarness().extractResult(result.output).finalMessage,
    ).toContain('agy-receipt-42');
    expect(
      JSON.parse(
        await readFile(
          join(f.home, '.gemini', 'antigravity-cli', 'settings.json'),
          'utf8',
        ),
      ),
    ).toEqual({modelProvider: 'gemini'});
    expect(
      await readdir(join(f.home, '.gemini', 'config', 'projects')),
    ).toEqual([]);
  });

  it('fails closed when headless normal mode denies the mock tool', async () => {
    const f = await fixture('call');
    await expect(
      runAntigravityWithMcp({
        ...f.options,
        input: {...f.options.input, permissionMode: 'default'},
      }),
    ).rejects.toMatchObject({category: 'execution_failed'});
    const observation = await f.controller.finalize({
      harnessReady: false,
      harnessSucceeded: false,
    });
    expect(observation.calls).toHaveLength(0);
  });

  it('rejects an inherited global server before model execution', async () => {
    const f = await fixture('negative');
    await mkdir(join(f.home, '.gemini', 'config'), {recursive: true});
    await writeFile(
      join(f.home, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {inherited: {serverUrl: 'http://127.0.0.1:1/mcp'}},
      }),
    );
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category:
        'configuration_failed' satisfies AntigravityMcpError['category'],
    });
    expect(f.requests).toHaveLength(0);
    await expect(
      readFile(join(f.work, '.agents', 'mcp_config.json')),
    ).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects workspace plugins that can supply MCP servers', async () => {
    const f = await fixture('negative');
    await mkdir(join(f.work, '.agents', 'plugins', 'inherited'), {
      recursive: true,
    });
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category:
        'configuration_failed' satisfies AntigravityMcpError['category'],
    });
    expect(f.requests).toHaveLength(0);
  });

  it('rejects custom agents that can supply MCP servers', async () => {
    const f = await fixture('negative');
    await mkdir(join(f.work, '.agents', 'agents', 'inherited'), {
      recursive: true,
    });
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category:
        'configuration_failed' satisfies AntigravityMcpError['category'],
    });
    expect(f.requests).toHaveLength(0);
  });

  it('rejects MCP config in a workspace ancestor', async () => {
    const f = await fixture('negative');
    await mkdir(join(f.root, '.agents'), {recursive: true});
    await writeFile(
      join(f.root, '.agents', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {inherited: {serverUrl: 'http://127.0.0.1:1/mcp'}},
      }),
    );
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category:
        'configuration_failed' satisfies AntigravityMcpError['category'],
    });
    expect(f.requests).toHaveLength(0);
  });

  it('rejects non-loopback MCP URLs and undeclared tool grants', async () => {
    const f = await fixture('negative');
    await expect(
      runAntigravityWithMcp({
        ...f.options,
        servers: {
          linear: {url: 'https://example.com/mcp', tools: ['get_issue']},
        },
      }),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    await expect(
      runAntigravityWithMcp({
        ...f.options,
        input: {
          ...f.options.input,
          allowedMcpTools: [{server: 'linear', tool: 'missing'}],
        },
      }),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    expect(f.requests).toHaveLength(0);
  });

  it('cannot pass a negative assertion when the mock is unreachable', async () => {
    const f = await fixture('negative');
    const result = await runAntigravityWithMcp({
      ...f.options,
      servers: {
        linear: {
          url: 'http://127.0.0.1:1/unreachable',
          tools: ['get_issue'],
        },
      },
    });
    const observation = await f.controller.finalize({
      harnessReady: result.harnessReady,
      harnessSucceeded: true,
    });
    expect(observation.ready).toBe(false);
    expect(observation.failures).toContain('not_ready');
    expect(observation.calls).toHaveLength(0);
  });

  it('cannot pass a negative assertion when MCP startup is denied', async () => {
    const f = await fixture('negative');
    let harnessReady = false;
    try {
      const run = await runAntigravityWithMcp({
        ...f.options,
        input: {...f.options.input, timeoutMs: 3500},
        servers: {
          linear: {url: f.deniedUrl, tools: ['get_issue']},
        },
      });
      harnessReady = run.harnessReady;
    } catch {
      // A rejected harness also prevents a passing negative assertion.
    }
    const observation = await f.controller.finalize({
      harnessReady,
      harnessSucceeded: harnessReady,
    });
    expect(f.deniedContacts()).toBeGreaterThan(0);
    expect(observation.ready).toBe(false);
    expect(observation.failures).toContain('not_ready');
  }, 10000);

  it('keeps concurrent mock calls in separate controller logs', async () => {
    const first = await fixture('call');
    const second = await fixture('call');
    second.options.input.env.HOME = first.home;
    const [firstRun, secondRun] = await Promise.all([
      runAntigravityWithMcp(first.options),
      runAntigravityWithMcp(second.options),
    ]);
    const [firstLog, secondLog] = await Promise.all([
      first.controller.finalize({
        harnessReady: firstRun.harnessReady,
        harnessSucceeded: true,
      }),
      second.controller.finalize({
        harnessReady: secondRun.harnessReady,
        harnessSucceeded: true,
      }),
    ]);
    for (const log of [firstLog, secondLog]) {
      expect(log.ready).toBe(true);
      expect(log.failures).toEqual([]);
      expect(log.calls).toHaveLength(1);
    }
    expect(
      await readdir(join(first.home, '.gemini', 'config', 'projects')),
    ).toEqual([]);
  });

  it('cancels an active model request and removes the mock config', async () => {
    const f = await fixture('hang');
    const abort = new AbortController();
    const run = runAntigravityWithMcp({
      ...f.options,
      input: {...f.options.input, signal: abort.signal},
    });
    const deadline = Date.now() + 10000;
    while (f.requests.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.requests.length).toBeGreaterThan(0);
    abort.abort();
    await expect(run).rejects.toMatchObject({category: 'execution_failed'});
    await expect(
      readFile(join(f.work, '.agents', 'mcp_config.json')),
    ).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      await readdir(join(f.home, '.gemini', 'config', 'projects')),
    ).toEqual([]);
  });

  it('bounds a stalled model request and removes the mock config', async () => {
    const f = await fixture('hang');
    await expect(
      runAntigravityWithMcp({
        ...f.options,
        input: {...f.options.input, timeoutMs: 800},
      }),
    ).rejects.toMatchObject({category: 'execution_failed'});
    await expect(
      readFile(join(f.work, '.agents', 'mcp_config.json')),
    ).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      await readdir(join(f.home, '.gemini', 'config', 'projects')),
    ).toEqual([]);
  });
});
