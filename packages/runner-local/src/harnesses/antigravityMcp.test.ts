import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {runJob} from '../index.js';
import {startMcpMockController} from '../mcpMocks/controller.js';
import type {LocalRunnerJob} from '../runTypes.js';
import {AntigravityHarness} from './antigravity.js';
import {
  inspectAntigravityMcp,
  logicalMcpToolEvents,
  runAntigravityWithMcp,
} from './antigravityMcp.js';
import {createToolEvent} from './parsing.js';
import type {ToolEvent} from './types.js';

const executable = process.env.DYNOBOX_ANTIGRAVITY_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(mode: 'call' | 'negative' | 'hang') {
  for (const key of Object.keys(process.env))
    if (/^(GEMINI_|GOOGLE_|GCLOUD_|GCP_|AGY_|ANTIGRAVITY_)/.test(key))
      vi.stubEnv(key, undefined);
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
  let targetServer = 'linear';
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
    const hasToolResult = body.includes('functionResponse');
    const part =
      mode === 'call' && tool && !hasToolResult
        ? {
            functionCall: {
              name: 'call_mcp_tool',
              args: {
                ServerName: targetServer,
                ToolName: 'get_issue',
                Arguments: {id: 'DYNO-1'},
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
    servers: {
      linear: {
        url: controller.urls.linear!,
        tools: ['get_issue'],
        isDiscovered: () => controller.isDiscovered('linear'),
      },
    },
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
    callServer: (name: string) => {
      targetServer = name;
    },
  };
}

async function ownedViews(home: string) {
  return (await readdir(home)).filter((name) =>
    name.startsWith('.dynobox-agy-mcp-'),
  );
}
async function globalConfig(home: string, value: unknown) {
  const path = join(home, '.gemini', 'config', 'mcp_config.json');
  await mkdir(join(home, '.gemini', 'config'), {recursive: true});
  await writeFile(path, JSON.stringify(value));
  return path;
}

// All native model/MCP traffic uses loopback and synthetic API keys.
describe.skipIf(!executable)(
  'native Antigravity selective MCP runtime',
  {timeout: 30_000},
  () => {
    it.each(['call', 'negative'] as const)(
      'runs %s through the public runner with automatic mock grants',
      async (mode) => {
        const f = await fixture(mode);
        const job: LocalRunnerJob = {
          id: 'native-antigravity',
          harness: 'antigravity',
          permissionMode: 'default',
          iteration: 0,
          model: f.options.input.model,
          scenario: {
            id: 'receipt',
            name: 'Read a receipt',
            prompt: f.options.input.prompt,
            harnesses: [{id: 'antigravity'}],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            mcpMocks: {
              linear: {
                tools: {
                  get_issue: {
                    inputSchema: {type: 'object'},
                    response: {
                      content: [{type: 'text', text: 'agy-receipt-42'}],
                    },
                  },
                },
              },
            },
            assertions: [
              {
                id: 'receipt',
                type: mode === 'call' ? 'mcp.called' : 'mcp.notCalled',
                server: 'linear',
                tool: 'get_issue',
              },
            ],
          },
        };
        const result = await runJob(job, {
          harnesses: [new AntigravityHarness({executable: executable!})],
          scratchRoot: f.root,
          env: f.options.input.env,
          allowUnmockedMcp: true,
          timeoutMs: 20000,
        });
        expect(result.status, result.diagnostics.join('\n')).toBe('passed');
        expect(result.mcp).toMatchObject({ready: true, failures: []});
        expect(result.mcp?.calls).toHaveLength(mode === 'call' ? 1 : 0);
      },
    );

    it('allows an unrelated HTTP tool after consent while the declared mock remains unused', async () => {
      const f = await fixture('call');
      f.callServer('other');
      const extra = await startMcpMockController({
        other: {
          tools: {
            get_issue: {
              inputSchema: {type: 'object'},
              response: {content: [{type: 'text', text: 'agy-receipt-42'}]},
            },
          },
        },
      });
      cleanup.push(() =>
        extra.finalize({harnessReady: false, harnessSucceeded: false}),
      );
      await globalConfig(f.home, {
        mcpServers: {other: {serverUrl: extra.urls.other}},
      });
      const result = await runAntigravityWithMcp(f.options);
      const mock = await f.controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      const real = await extra.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(mock).toMatchObject({ready: true, calls: [], failures: []});
      expect(real.calls).toMatchObject([{server: 'other', tool: 'get_issue'}]);
    });

    it('preserves a plugin MCP alongside the declared mock', async () => {
      const f = await fixture('call');
      f.callServer('addon_extra');
      const extra = await startMcpMockController({
        other: {
          tools: {
            get_issue: {
              inputSchema: {type: 'object'},
              response: {content: [{type: 'text', text: 'agy-receipt-42'}]},
            },
          },
        },
      });
      cleanup.push(() =>
        extra.finalize({harnessReady: false, harnessSucceeded: false}),
      );
      const plugin = join(f.home, '.gemini', 'config', 'plugins', 'addon');
      await mkdir(plugin, {recursive: true});
      await writeFile(
        join(plugin, 'plugin.json'),
        JSON.stringify({
          name: 'addon',
          version: '1.0.0',
          description: 'Synthetic plugin',
        }),
      );
      await writeFile(
        join(plugin, 'mcp_config.json'),
        JSON.stringify({mcpServers: {extra: {serverUrl: extra.urls.other}}}),
      );
      await runAntigravityWithMcp(f.options);
      expect(extra.isDiscovered('other')).toBe(true);
      const real = await extra.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(real.calls).toHaveLength(1);
    });

    it.each(['call', 'negative'] as const)(
      'runs %s with a synthetic model',
      async (mode) => {
        const f = await fixture(mode);
        const live: ToolEvent[] = [];
        const result = await runAntigravityWithMcp({
          ...f.options,
          input: {...f.options.input, onToolEvent: (event) => live.push(event)},
        });
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
        expect(result.toolEvents).toEqual(live);
        expect(result.toolEvents).toMatchObject(
          mode === 'call'
            ? [
                {
                  rawName: 'mcp__linear__get_issue',
                  input: {id: 'DYNO-1'},
                  status: 'success',
                },
              ]
            : [],
        );
        expect(
          new AntigravityHarness().extractResult(result.output).finalMessage,
        ).toContain(mode === 'call' ? 'agy-receipt-42' : 'READY');
        expect(await ownedViews(f.home)).toEqual([]);
        await expect(readdir(join(f.work, '.agents'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    it.each(['Gemini 3.8 Flash (Low)', 'gemini-3.8-flash'])(
      'accepts model %s with scoped normal-permission mock grants',
      async (model) => {
        const f = await fixture('call');
        const result = await runAntigravityWithMcp({
          ...f.options,
          input: {
            ...f.options.input,
            model,
            permissionMode: 'default',
            allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
          },
        });
        expect(result.toolEvents).toMatchObject([
          {rawName: 'mcp__linear__get_issue', status: 'success'},
        ]);
        const observation = await f.controller.finalize({
          harnessReady: result.harnessReady,
          harnessSucceeded: true,
        });
        expect(observation.calls).toHaveLength(1);
        expect(
          JSON.parse(
            await readFile(
              join(f.home, '.gemini', 'antigravity-cli', 'settings.json'),
              'utf8',
            ),
          ),
        ).toEqual({modelProvider: 'gemini'});
      },
    );

    it('retains evidence of a denied mock attempt for receipt reconciliation', async () => {
      const f = await fixture('call');
      const result = await runAntigravityWithMcp({
        ...f.options,
        input: {...f.options.input, permissionMode: 'default'},
      });
      expect(result.toolEvents).toMatchObject([
        {rawName: 'mcp__linear__get_issue', status: 'failure'},
      ]);
      const observation = await f.controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(0);
    });

    it('replaces a global HTTP target completely and preserves unrelated MCPs and skills', async () => {
      const f = await fixture('call');
      const extra = await startMcpMockController({
        extra: {
          tools: {
            ping: {inputSchema: {type: 'object'}, response: {content: []}},
          },
        },
      });
      cleanup.push(() =>
        extra.finalize({harnessReady: false, harnessSucceeded: false}),
      );
      const path = await globalConfig(f.home, {
        mcpServers: {
          linear: {
            serverUrl: f.deniedUrl,
            headers: {Authorization: 'old-synthetic-credential'},
            oauth: {clientId: 'old-client'},
          },
          extra: {serverUrl: extra.urls.extra},
        },
      });
      const original = await readFile(path, 'utf8');
      await mkdir(join(f.home, '.gemini', 'config', 'skills', 'keep-skill'), {
        recursive: true,
      });
      await writeFile(
        join(f.home, '.gemini', 'config', 'skills', 'keep-skill', 'SKILL.md'),
        '---\nname: keep-skill\ndescription: GLOBAL_SKILL_MARKER_2819\n---\nRead assets/example.txt.',
      );
      const shared = join(f.home, 'shared-skills', 'external-skill');
      await mkdir(shared, {recursive: true});
      await writeFile(
        join(shared, 'SKILL.md'),
        '---\nname: external-skill\ndescription: RELATIVE_SKILL_MARKER_9051\n---\nRead assets/example.txt.',
      );
      await writeFile(
        join(f.home, '.gemini', 'config', 'skills.json'),
        JSON.stringify({entries: [{path: '../../shared-skills'}]}),
      );
      const result = await runAntigravityWithMcp(f.options);
      expect(f.deniedContacts()).toBe(0);
      expect(extra.isDiscovered('extra')).toBe(true);
      expect(
        f.requests.some((body) => body.includes('GLOBAL_SKILL_MARKER_2819')),
      ).toBe(true);
      expect(
        f.requests.some((body) => body.includes('RELATIVE_SKILL_MARKER_9051')),
      ).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(
        new AntigravityHarness().extractResult(result.output).finalMessage,
      ).toBe('agy-receipt-42');
      expect(await ownedViews(f.home)).toEqual([]);
    });

    it('shadows the same HTTP target in workspace configuration without editing it', async () => {
      const f = await fixture('call');
      await mkdir(join(f.work, '.agents'));
      const path = join(f.work, '.agents', 'mcp_config.json');
      await writeFile(
        path,
        JSON.stringify({mcpServers: {linear: {serverUrl: f.deniedUrl}}}),
      );
      const original = await readFile(path, 'utf8');
      const result = await runAntigravityWithMcp(f.options);
      expect(f.deniedContacts()).toBe(0);
      expect(result.toolEvents).toMatchObject([
        {rawName: 'mcp__linear__get_issue', status: 'success'},
      ]);
      expect(await readFile(path, 'utf8')).toBe(original);
    });

    it('rejects a disconnected mock before sending the task', async () => {
      const f = await fixture('negative');
      await expect(
        runAntigravityWithMcp({
          ...f.options,
          servers: {
            linear: {
              ...f.options.servers.linear,
              url: 'http://127.0.0.1:1/mcp',
            },
          },
        }),
      ).rejects.toMatchObject({category: 'not_ready'});
      expect(
        f.requests.filter(
          (body) => !body.includes('You are a conversation title'),
        ),
      ).toHaveLength(0);
      expect(await ownedViews(f.home)).toEqual([]);
    });

    it('keeps concurrent jobs sharing a profile in separate receipt logs', async () => {
      const first = await fixture('call'),
        second = await fixture('call');
      const results = await Promise.all([
        runAntigravityWithMcp(first.options),
        runAntigravityWithMcp({
          ...second.options,
          input: {
            ...second.options.input,
            env: {...second.options.input.env, HOME: first.home},
          },
        }),
      ]);
      for (const [index, f] of [first, second].entries()) {
        const observation = await f.controller.finalize({
          harnessReady: results[index]!.harnessReady,
          harnessSucceeded: true,
        });
        expect(observation.calls).toHaveLength(1);
        expect(observation.failures).toEqual([]);
      }
      expect(await ownedViews(first.home)).toEqual([]);
    });

    it.each(['cancel', 'timeout'] as const)(
      'cleans its config view after %s',
      async (mode) => {
        const f = await fixture('hang');
        const abort = new AbortController();
        const timer =
          mode === 'cancel' ? setTimeout(() => abort.abort(), 1000) : undefined;
        try {
          await expect(
            runAntigravityWithMcp({
              ...f.options,
              input: {
                ...f.options.input,
                signal: abort.signal,
                timeoutMs: mode === 'timeout' ? 1000 : 20000,
              },
            }),
          ).rejects.toMatchObject({
            category: mode === 'timeout' ? 'timed_out' : 'execution_failed',
          });
          expect(await ownedViews(f.home)).toEqual([]);
        } finally {
          clearTimeout(timer);
        }
      },
    );
  },
);

async function fakeFixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-agy-acp-unit-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const home = join(root, 'home'),
    work = join(root, 'work'),
    executable = join(root, 'agy');
  await mkdir(work);
  await mkdir(join(home, '.gemini', 'antigravity-cli'), {recursive: true});
  await writeFile(
    join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    '{"modelProvider":"synthetic"}',
  );
  const capture = join(root, 'capture.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
if (process.argv.includes('--version')) { console.log(process.env.FAKE_VERSION || '1.5.2'); process.exit(0); }
const view = process.argv[process.argv.indexOf('--gemini-dir') + 1];
const config = JSON.parse(fs.readFileSync(path.join(view, 'config', 'mcp_config.json'), 'utf8'));
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({config, args: process.argv.slice(2), home: process.env.HOME, data: fs.realpathSync(path.join(view, 'antigravity-cli')), view}));
const send = (value) => console.log(JSON.stringify({jsonrpc:'2.0', ...value}));
const update = (value) => send({method: 'session/update', params: {sessionId:'session', update:value}});
readline.createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line), result=(value)=>send({id:req.id,result:value});
 if(req.method==='initialize') return result({agentCapabilities:{mcpCapabilities:{http:true}}});
 if(req.method==='session/new') return result({sessionId:'session',models:{availableModels:[{modelId:'native-model',name:'Pretty Model'}]}});
 if(req.method==='session/set_model') return result({});
 if(req.method==='session/prompt') {
  if(process.env.FAKE_MODE==='hang') return;
  if(process.env.FAKE_MODE==='exit') {console.error('native debug error');process.exit(9);}
  if(process.env.FAKE_MODE==='malformed') {console.log('{bad json');return;}
  if(process.env.FAKE_MODE==='tool') {
   update({sessionUpdate:'tool_call',toolCallId:'call',name:'call_mcp_tool',rawInput:{ServerName:'linear',ToolName:'get_issue',Arguments:{id:'1'}},status:'in_progress'});
   update({sessionUpdate:'tool_call_update',toolCallId:'call',status:'completed',rawOutput:'received'});
  }
  if(process.env.FAKE_MODE!=='empty') update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'DONE'}});
  result({stopReason:process.env.FAKE_MODE==='cancelled'?'cancelled':'end_turn'});
 }
});
`,
    {mode: 0o755},
  );
  const options = {
    executable,
    input: {
      workDir: work,
      env: {HOME: home, CAPTURE: capture, FAKE_MODE: mode},
      prompt: 'literal $(text)\nDo not quote this.',
      timeoutMs: 5000,
    },
    servers: {
      linear: {url: 'http://127.0.0.1:12345/mcp', tools: ['get_issue']},
    },
  };
  return {root, home, work, capture, options};
}

it('passively inventories JSONC profile names and reports incomplete inventory', async () => {
  const f = await fakeFixture();
  const path = await globalConfig(f.home, {});
  await writeFile(
    path,
    '{// config\n"mcpServers":{"linear":{"serverUrl":"https://example.invalid"},"other":{"command":"never-run"},},}',
  );
  expect(await inspectAntigravityMcp({env: {HOME: f.home}})).toEqual({
    servers: ['linear', 'other'],
    complete: false,
  });
  expect(
    await new AntigravityHarness().inspectMcp({env: {HOME: f.home}}),
  ).toEqual({servers: ['linear', 'other'], complete: false});
  await expect(readFile(f.capture)).rejects.toMatchObject({code: 'ENOENT'});
});

it('replaces whole target definitions while retaining profile/login directory identity', async () => {
  const f = await fakeFixture();
  const path = await globalConfig(f.home, {
    mcpServers: {
      linear: {
        serverUrl: 'https://old.invalid',
        headers: {Authorization: 'synthetic'},
        disabled: true,
        disabledTools: ['get_issue'],
      },
      other: {command: 'never-run', args: ['test']},
    },
  });
  const before = await readFile(path, 'utf8');
  const result = await runAntigravityWithMcp({
    ...f.options,
    input: {...f.options.input, model: 'Pretty Model'},
  });
  const captured = JSON.parse(await readFile(f.capture, 'utf8'));
  expect(captured.config.mcpServers).toEqual({
    linear: {serverUrl: f.options.servers.linear.url},
    other: {command: 'never-run', args: ['test']},
  });
  expect(captured.home).toBe(await realpath(f.home));
  expect(captured.data).toBe(
    await realpath(join(f.home, '.gemini', 'antigravity-cli')),
  );
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(
    new AntigravityHarness().extractResult(result.output).finalMessage,
  ).toBe('DONE');
  expect(await ownedViews(f.home)).toEqual([]);
});

it('emits logical live events that match the returned evidence', async () => {
  const f = await fakeFixture('tool'),
    live: ToolEvent[] = [];
  const result = await runAntigravityWithMcp({
    ...f.options,
    input: {...f.options.input, onToolEvent: (event) => live.push(event)},
  });
  expect(result.toolEvents).toEqual(live);
  expect(live).toMatchObject([
    {
      kind: 'mcp',
      rawName: 'mcp__linear__get_issue',
      input: {id: '1'},
      status: 'success',
    },
  ]);
});

it.each(['empty', 'malformed', 'cancelled', 'exit'])(
  'rejects %s native output and cleans the view',
  async (mode) => {
    const f = await fakeFixture(mode);
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category: 'execution_failed',
    });
    expect(await ownedViews(f.home)).toEqual([]);
  },
);

it('retains raw diagnostics on native failure', async () => {
  const f = await fakeFixture('exit');
  await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
    output: {stderr: 'native debug error'},
  });
});

it('bounds a stalled native task', async () => {
  const f = await fakeFixture('hang');
  await expect(
    runAntigravityWithMcp({
      ...f.options,
      input: {...f.options.input, timeoutMs: 500},
    }),
  ).rejects.toMatchObject({category: 'timed_out'});
  expect(await ownedViews(f.home)).toEqual([]);
});

it('rejects same-named stdio targets before ACP starts', async () => {
  const f = await fakeFixture();
  await globalConfig(f.home, {mcpServers: {linear: {command: 'never-run'}}});
  await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
    category: 'configuration_failed',
  });
  await expect(readFile(f.capture)).rejects.toMatchObject({code: 'ENOENT'});
});

it.each(['{bad json', '{"mcpServers":[]}'])(
  'rejects malformed profile configuration %s',
  async (source) => {
    const f = await fakeFixture();
    const path = await globalConfig(f.home, {});
    await writeFile(path, source);
    await expect(runAntigravityWithMcp(f.options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(readFile(f.capture)).rejects.toMatchObject({code: 'ENOENT'});
  },
);

it.each([
  '--gemini-dir=elsewhere',
  '--settings={}',
  '--agent=other',
  '--continue',
  '--model=other',
])('rejects conflicting %s before launch', async (arg) => {
  const f = await fakeFixture();
  await expect(
    runAntigravityWithMcp({...f.options, extraArgs: [arg]}),
  ).rejects.toMatchObject({category: 'configuration_failed'});
  await expect(readFile(f.capture)).rejects.toMatchObject({code: 'ENOENT'});
});

it('rejects unverified older native versions', async () => {
  const f = await fakeFixture();
  await expect(
    runAntigravityWithMcp({
      ...f.options,
      input: {
        ...f.options.input,
        env: {...f.options.input.env, FAKE_VERSION: '1.2.11'},
      },
    }),
  ).rejects.toMatchObject({
    category: 'unsupported_version',
    output: {stdout: '1.2.11'},
  });
});

it('normalizes only declared dispatcher calls', () => {
  const events = [
    createToolEvent(
      'call_mcp_tool',
      {ServerName: 'linear', ToolName: 'get_issue', Arguments: {id: '1'}},
      'success',
    ),
    createToolEvent(
      'call_mcp_tool',
      {ServerName: 'other', ToolName: 'ping'},
      'failure',
    ),
  ];
  expect(
    logicalMcpToolEvents(events, {
      linear: {url: 'unused', tools: ['get_issue']},
    }),
  ).toEqual([
    createToolEvent('mcp__linear__get_issue', {id: '1'}, 'success'),
    events[1],
  ]);
});
