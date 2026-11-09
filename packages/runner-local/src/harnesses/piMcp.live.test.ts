import {existsSync} from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import type {McpToolResult} from '@dynobox/sdk';
import {execa} from 'execa';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {runJob} from '../index.js';
import {startMcpMockController} from '../mcpMocks/controller.js';
import type {LocalRunnerJob} from '../runTypes.js';
import {PiHarness} from './pi.js';
import {runPiWithMcp} from './piMcp.js';

const executable = process.env.DYNOBOX_PI_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  mode:
    | 'call'
    | 'negative'
    | 'failed'
    | 'denied'
    | 'hang'
    | 'invalid'
    | 'tool-error'
    | 'request-error'
    | 'listing-failed'
    | 'startup-hang'
    | 'provider-retry'
    | 'invalid-retry'
    | 'tool-only' = 'call',
  response?: McpToolResult,
) {
  for (const key of Object.keys(process.env))
    if (
      /^(PI_|OPENAI_|ANTHROPIC_)/.test(key) &&
      key !== 'DYNOBOX_PI_MCP_EXECUTABLE'
    )
      vi.stubEnv(key, undefined);
  const root = await mkdtemp(join(tmpdir(), 'dynobox-pi-native-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const controller = await startMcpMockController({
    linear: {
      instructions: 'MCP_SERVER_INSTRUCTIONS: use issue IDs for Linear tools.',
      tools: {
        get_issue: {
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}},
            required: ['id'],
          },
          response: response ?? {
            ...(mode === 'tool-error' ? {isError: true} : {}),
            content: [{type: 'text', text: 'fixture-receipt-42'}],
          },
        },
      },
    },
  });
  cleanup.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: Record<string, unknown>[] = [];
  let realContacts = 0;
  let originalContacts = 0;
  let rejectedRequest = false;
  let selectedTool: string | undefined = 'mcp__linear__get_issue';
  const modelHeaders: string[] = [];
  const proxyHeaders: {
    authorization: string | undefined;
    original: string | string[] | undefined;
  }[] = [];
  const provider = createServer(async (request, response) => {
    if (request.url === '/original-linear-mcp') {
      originalContacts++;
      response.writeHead(503).end();
      return;
    }
    if (request.url === '/proxy-mcp' && request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/denied') {
      response.writeHead(403).end();
      return;
    }
    if (request.url === '/real-mcp') {
      realContacts++;
      response.writeHead(503).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/proxy-mcp') {
      proxyHeaders.push({
        authorization: request.headers.authorization,
        original: request.headers['x-original'],
      });
      if (mode === 'startup-hang') return;
      if (
        (mode === 'listing-failed' && body.method === 'tools/list') ||
        (mode === 'request-error' &&
          body.method === 'tools/call' &&
          !rejectedRequest)
      ) {
        rejectedRequest = true;
        response.writeHead(503).end('Temporary fixture failure');
        return;
      }
      const forwarded = await fetch(controller.urls.linear!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      });
      response.writeHead(forwarded.status, {
        'content-type':
          forwarded.headers.get('content-type') ?? 'application/json',
      });
      response.end(await forwarded.text());
      return;
    }
    requests.push(body);
    modelHeaders.push(request.headers.authorization ?? '');
    if (mode === 'provider-retry' && requests.length === 1) {
      response.writeHead(503).end('Temporary provider failure');
      return;
    }
    if (mode === 'hang') return;
    const tool = body.tools?.find((entry: {function?: {name?: string}}) =>
      selectedTool
        ? entry.function?.name === selectedTool
        : entry.function?.name?.startsWith('mcp__'),
    );
    const hasReceipt = /fixture-receipt-42|structured-receipt-42/.test(
      JSON.stringify(body.messages),
    );
    const call =
      !!tool &&
      !hasReceipt &&
      (mode === 'call' ||
        mode === 'provider-retry' ||
        mode === 'invalid-retry' ||
        mode === 'tool-only' ||
        mode === 'request-error' ||
        ((mode === 'invalid' || mode === 'tool-error') &&
          requests.length === 1)) &&
      requests.length < 10;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_fixture',
              type: 'function',
              function: {
                name: tool?.function.name ?? 'missing',
                arguments:
                  mode === 'invalid' ||
                  (mode === 'invalid-retry' && requests.length === 1)
                    ? '{"unexpected":42}'
                    : '{"id":"DYNO-1"}',
              },
            },
          ],
        }
      : {
          content:
            mode === 'tool-only'
              ? ''
              : hasReceipt
                ? 'fixture-receipt-42'
                : 'No calls needed.',
        };
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const [part, finish] of [
      [{role: 'assistant', ...delta}, null],
      [{}, call ? 'tool_calls' : 'stop'],
    ] as const)
      response.write(
        `data: ${JSON.stringify({id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{index: 0, delta: part, finish_reason: finish}]})}\n\n`,
      );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        provider.closeAllConnections();
        provider.close(() => resolve());
      }),
  );
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const markers = ['user', 'project', 'package'].map((name) =>
    join(root, name + '-started'),
  );
  const profile = join(root, 'profile');
  await mkdir(join(profile, 'extensions'), {recursive: true});
  await mkdir(join(root, '.pi', 'extensions'), {recursive: true});
  const packageDir = join(root, 'fixture-package');
  await mkdir(packageDir);
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'fixture-package',
      pi: {extensions: ['./index.js'], skills: ['./skills']},
    }),
  );
  const extensionPaths = [
    join(profile, 'extensions', 'sentinel.js'),
    join(root, '.pi', 'extensions', 'sentinel.js'),
    join(packageDir, 'index.js'),
  ];
  for (const [index, path] of extensionPaths.entries()) {
    await writeFile(
      path,
      `import {writeFileSync} from 'node:fs'; export default function() {writeFileSync(${JSON.stringify(markers[index])}, 'started'); fetch(${JSON.stringify(base + '/real-mcp')});}`,
    );
  }
  const configPath = join(profile, 'settings.json');
  const source = JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'fixture',
    packages: [packageDir],
  });
  await writeFile(configPath, source);
  await writeFile(
    join(profile, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `${base}/v1`,
          api: 'openai-completions',
          apiKey: 'synthetic',
          models: [
            {
              id: 'fixture',
              reasoning: false,
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  const env = {HOME: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1'};
  await mkdir(join(profile, 'skills', 'fixture'), {recursive: true});
  await writeFile(
    join(profile, 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: Native fixture skill\n---\nSay fixture.\n',
  );
  for (const [directory, name] of [
    [join(root, '.pi', 'skills', 'project-fixture'), 'project-fixture'],
    [join(packageDir, 'skills', 'package-fixture'), 'package-fixture'],
  ]) {
    await mkdir(directory!, {recursive: true});
    await writeFile(
      join(directory!, 'SKILL.md'),
      `---
name: ${name}
description: ${name} skill marker
---
Say fixture.
`,
    );
  }
  const options = {
    executable: executable!,
    input: {
      workDir: root,
      env,
      prompt: 'Use the Linear tool and report its receipt.',
      model: 'fixture/fixture',
      permissionMode: 'dangerous' as const,
      timeoutMs: 20000,
    },
    servers: {
      linear: {
        url:
          mode === 'denied'
            ? `${base}/denied`
            : mode === 'failed'
              ? `http://127.0.0.1:1/${'a'.repeat(48)}`
              : mode === 'request-error' ||
                  mode === 'listing-failed' ||
                  mode === 'startup-hang'
                ? `${base}/proxy-mcp`
                : controller.urls.linear!,
        tools: ['get_issue'],
      },
    },
  };
  return {
    options,
    controller,
    requests,
    markers,
    configPath,
    source,
    contacts: () => realContacts,
    originalUrl: base + '/original-linear-mcp',
    originalContacts: () => originalContacts,
    profile,
    root,
    proxyUrl: base + '/proxy-mcp',
    proxyHeaders,
    modelHeaders,
    selectTool: (name: string | undefined) => {
      selectedTool = name;
    },
  };
}

async function configFor(
  f: Awaited<ReturnType<typeof fixture>>,
  mcpServers: Record<string, unknown>,
) {
  const path = join(f.profile, 'mcp.json');
  await writeFile(path, JSON.stringify({mcpServers}));
  return path;
}

describe.skipIf(!executable)(
  'native Pi MCP runtime (local model, no credits)',
  () => {
    it.each(['call', 'negative', 'unrelated'] as const)(
      'runs %s through the public runner with logical assertions',
      async (mode) => {
        const f = await fixture(mode === 'negative' ? 'negative' : 'call');
        const servers: Record<string, unknown> = {linear: {url: f.originalUrl}};
        if (mode === 'unrelated') {
          const other = await startMcpMockController({
            other: {
              tools: {
                get_issue: {
                  inputSchema: {type: 'object'},
                  response: {
                    content: [{type: 'text', text: 'fixture-receipt-42'}],
                  },
                },
              },
            },
          });
          cleanup.push(() =>
            other.finalize({harnessReady: false, harnessSucceeded: false}),
          );
          servers.other = {url: other.urls.other, exposure: 'direct'};
          f.selectTool('mcp__other__get_issue');
        }
        await configFor(f, servers);
        const job: LocalRunnerJob = {
          id: 'native-pi',
          harness: 'pi',
          model: f.options.input.model,
          permissionMode: 'default',
          iteration: 0,
          scenario: {
            id: 'receipt',
            name: 'Read a receipt',
            prompt: f.options.input.prompt,
            harnesses: [{id: 'pi'}],
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
                      content: [{type: 'text', text: 'fixture-receipt-42'}],
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
          harnesses: [new PiHarness({executable: executable!})],
          scratchRoot: f.root,
          env: f.options.input.env,
          timeoutMs: 20000,
        });
        expect(result.status, result.diagnostics.join('\n')).toBe('passed');
        expect(result.mcp).toMatchObject({ready: true, failures: []});
        expect(result.mcp?.calls).toHaveLength(mode === 'call' ? 1 : 0);
        expect(f.originalContacts()).toBe(0);
      },
      30000,
    );

    it.each(['default', 'dangerous'] as const)(
      'replaces target definitions with %s project trust and no original contacts',
      async (permissionMode) => {
        const f = await fixture('call');
        const marker = join(f.root, 'original-auth-executed');
        const helper = join(f.root, 'original-auth.mjs');
        await writeFile(
          helper,
          `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nconsole.log('synthetic-old-key');\n`,
          {mode: 0o700},
        );
        const quotedHelper = "'" + helper.replaceAll("'", "'\\''") + "'";
        const other = await startMcpMockController({
          other: {
            tools: {
              ping: {inputSchema: {type: 'object'}, response: {content: []}},
            },
          },
        });
        cleanup.push(() =>
          other.finalize({harnessReady: false, harnessSucceeded: false}),
        );
        const global = await configFor(f, {
          linear: {
            url: f.originalUrl,
            headers: {
              Authorization: '!' + quotedHelper,
              'X-Original': 'synthetic',
            },
            exposure: 'hidden',
            toolExposure: {'*': 'hidden'},
          },
          other: {url: other.urls.other},
        });
        const project = join(f.root, '.pi', 'mcp.json');
        await writeFile(
          project,
          JSON.stringify({
            mcpServers: {
              linear: {
                url: f.originalUrl,
                headers: {'X-Original': 'project-synthetic'},
              },
            },
          }),
        );
        const originals = await Promise.all(
          [global, project].map((path) => readFile(path, 'utf8')),
        );
        const result = await runPiWithMcp({
          ...f.options,
          input: {...f.options.input, permissionMode},
          servers: {linear: {...f.options.servers.linear, url: f.proxyUrl}},
        });
        expect(result.toolEvents).toMatchObject([
          {rawName: 'mcp__linear__get_issue', status: 'success'},
        ]);
        expect(f.originalContacts()).toBe(0);
        expect(other.isDiscovered('other')).toBe(true);
        expect(f.proxyHeaders.length).toBeGreaterThan(0);
        expect(
          f.proxyHeaders.every(
            (headers) =>
              headers.authorization === undefined &&
              headers.original === undefined,
          ),
        ).toBe(true);
        await expect(readFile(marker)).rejects.toMatchObject({code: 'ENOENT'});
        expect(
          await Promise.all(
            [global, project].map((path) => readFile(path, 'utf8')),
          ),
        ).toEqual(originals);
      },
      30000,
    );

    it('overrides extension-registered HTTP targets while preserving a user MCP command', async () => {
      const f = await fixture('call');
      const registered = join(f.root, 'registered.json');
      await writeFile(
        join(f.profile, 'extensions', 'registered.js'),
        `import {writeFileSync} from 'node:fs';export default function(pi) {pi.registerCommand('mcp',{description:'User command',handler:async()=>{}});pi.registerMcpServer('linear',{url:${JSON.stringify(f.originalUrl)}});pi.on('session_start',()=>writeFileSync(${JSON.stringify(registered)},JSON.stringify(pi.getMcpServers())));}`,
      );
      const result = await runPiWithMcp(f.options);
      expect(JSON.parse(await readFile(registered, 'utf8'))).toMatchObject([
        {name: 'linear', config: {url: f.originalUrl}},
      ]);
      expect(result.toolEvents).toMatchObject([
        {rawName: 'mcp__linear__get_issue', status: 'success'},
      ]);
      expect(f.originalContacts()).toBe(0);
    }, 30000);

    it.each(['file', 'env'] as const)(
      'preserves %s model authentication at the original profile path',
      async (source) => {
        const f = await fixture('call');
        const path = join(f.profile, 'models.json');
        const models = JSON.parse(await readFile(path, 'utf8'));
        const key = 'synthetic-' + source + '-key';
        if (source === 'file') {
          delete models.providers.fixture.apiKey;
          await writeFile(
            join(f.profile, 'auth.json'),
            JSON.stringify({fixture: {type: 'api_key', key}}),
          );
        } else models.providers.fixture.apiKey = '${DYNOBOX_PI_SYNTHETIC_KEY}';
        await writeFile(path, JSON.stringify(models));
        const original = await readFile(path, 'utf8');
        await runPiWithMcp({
          ...f.options,
          input: {
            ...f.options.input,
            env: {...f.options.input.env, DYNOBOX_PI_SYNTHETIC_KEY: key},
          },
        });
        expect(f.modelHeaders.length).toBeGreaterThan(0);
        expect(
          f.modelHeaders.every((header) => header === 'Bearer ' + key),
        ).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(original);
      },
      30000,
    );

    it('keeps colliding native tool spellings logical in evidence and callbacks', async () => {
      const f = await fixture('call');
      f.selectTool(undefined);
      const controller = await startMcpMockController({
        linear: {
          tools: Object.fromEntries(
            ['get-issue', 'get_issue'].map((name) => [
              name,
              {
                inputSchema: {type: 'object'},
                response: {
                  content: [{type: 'text', text: 'fixture-receipt-42'}],
                },
              },
            ]),
          ),
        },
      });
      cleanup.push(() =>
        controller.finalize({harnessReady: false, harnessSucceeded: false}),
      );
      const live: string[] = [];
      const result = await runPiWithMcp({
        ...f.options,
        input: {
          ...f.options.input,
          onToolEvent: (event) => live.push(event.rawName),
        },
        servers: {
          linear: {
            url: controller.urls.linear!,
            tools: ['get-issue', 'get_issue'],
          },
        },
      });
      const observation = await controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(1);
      const logical = 'mcp__linear__' + observation.calls[0]!.tool;
      expect(live).toEqual([logical]);
      expect(result.toolEvents?.[0]?.rawName).toBe(logical);
      expect(new PiHarness().extractResult(result.output).toolEvents).toEqual(
        result.toolEvents,
      );
    }, 30000);

    it.each([
      'global',
      'extension',
      'session_start extension',
      'agent_start extension',
    ] as const)(
      'rejects %s stdio targets without starting their process',
      async (source) => {
        const f = await fixture('negative');
        const marker = join(f.root, 'original-stdio-started');
        const registered = join(f.root, 'registered.json');
        const config = {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
          ],
        };
        if (source === 'global') await configFor(f, {linear: config});
        else {
          const registration = `pi.registerMcpServer('linear',${JSON.stringify(config)})`;
          await writeFile(
            join(f.profile, 'extensions', 'registered.js'),
            `import {writeFileSync} from 'node:fs';export default function(pi){${source === 'extension' ? registration : `pi.on('${source.split(' ')[0]}',()=>${registration})`};pi.on('${source === 'agent_start extension' ? 'agent_start' : 'session_start'}',()=>writeFileSync(${JSON.stringify(registered)},JSON.stringify(pi.getMcpServers())));}`,
          );
        }
        await expect(runPiWithMcp(f.options)).rejects.toMatchObject({
          category: 'configuration_failed',
          message: expect.stringContaining('uses stdio'),
        });
        expect(f.requests).toHaveLength(0);
        if (source !== 'global')
          expect(JSON.parse(await readFile(registered, 'utf8'))).toMatchObject([
            {name: 'linear', config},
          ]);
        await expect(readFile(marker)).rejects.toMatchObject({code: 'ENOENT'});
      },
      30000,
    );

    it.each(['active tools', 'selected tools'] as const)(
      'rejects a mock hidden by inherited before_agent_start %s changes',
      async (source) => {
        const f = await fixture('negative');
        const change =
          source === 'active tools'
            ? "pi.setActiveTools(pi.getActiveTools().filter(name=>!name.startsWith('mcp__')))"
            : "event.systemPromptOptions.selectedTools=['read']";
        await writeFile(
          join(f.profile, 'extensions', 'restrict-tools.js'),
          `export default pi=>pi.on('before_agent_start',event=>{${change};});`,
        );
        await expect(runPiWithMcp(f.options)).rejects.toMatchObject({
          category: 'not_ready',
          message: expect.stringContaining('did not activate MCP mock tool'),
        });
        expect(f.requests).toHaveLength(0);
      },
      30000,
    );

    it('closes unrelated stdio servers when mock startup is aborted', async () => {
      const f = await fixture('startup-hang');
      const script = join(f.root, 'unrelated-mcp.mjs'),
        pidFile = join(f.root, 'unrelated.pid'),
        closed = join(f.root, 'unrelated.closed');
      await writeFile(
        script,
        `import {writeFileSync} from 'node:fs';\nimport {createInterface} from 'node:readline';\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid));\nprocess.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0)});\nsetInterval(()=>{},1000);\nsetTimeout(()=>process.exit(0),30000).unref();\ncreateInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'unrelated',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`,
      );
      cleanup.push(async () => {
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
        if (!pid) return;
        const info = await execa('ps', ['-p', String(pid), '-o', 'command='], {
          reject: false,
        });
        if (info.stdout.includes(script)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
      });
      await configFor(f, {other: {command: process.execPath, args: [script]}});
      await expect(runPiWithMcp(f.options)).rejects.toMatchObject({
        category: 'not_ready',
      });
      expect(f.requests).toHaveLength(0);
      expect(await readFile(closed, 'utf8')).toBe('closed');
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    }, 30000);

    it.each(['call', 'negative'] as const)(
      'runs %s while preserving inherited extensions and skills',
      async (mode) => {
        const f = await fixture(mode);
        const result = await runPiWithMcp(f.options);
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
          new PiHarness().extractResult(result.output).finalMessage,
        ).toContain(
          mode === 'call' ? 'fixture-receipt-42' : 'No calls needed.',
        );
        expect(f.contacts()).toBe(3);
        for (const marker of f.markers)
          expect(await readFile(marker, 'utf8')).toBe('started');
        expect(await readFile(f.configPath, 'utf8')).toBe(f.source);
        expect(f.requests.length).toBeGreaterThan(0);
        expect(JSON.stringify(f.requests)).toContain('Native fixture skill');
        expect(JSON.stringify(f.requests)).toContain('MCP_SERVER_INSTRUCTIONS');
        expect(JSON.stringify(f.requests)).toContain(
          'project-fixture skill marker',
        );
        expect(JSON.stringify(f.requests)).toContain(
          'package-fixture skill marker',
        );
        if (mode === 'call') {
          expect(
            new PiHarness().extractResult(result.output).toolEvents,
          ).toEqual([
            expect.objectContaining({
              rawName: 'mcp__linear__get_issue',
              kind: 'mcp',
            }),
          ]);
          await execa(
            executable!,
            [
              '--mode',
              'json',
              '--no-session',
              '--approve',
              '--model',
              'fixture/fixture',
              'Say hello.',
            ],
            {
              cwd: f.options.input.workDir,
              env: f.options.input.env,
              timeout: 10000,
              reject: false,
            },
          );
          expect(f.contacts()).toBeGreaterThan(0);
          for (const marker of f.markers)
            expect(await readFile(marker, 'utf8')).toBe('started');
        }
      },
      30000,
    );

    it.each(['failed', 'denied'] as const)(
      'does not let %s startup pass a negative assertion',
      async (mode) => {
        const f = await fixture(mode);
        await expect(runPiWithMcp(f.options)).rejects.toMatchObject({
          category: 'not_ready',
          message: expect.stringContaining('did not activate MCP mock tool'),
        });
        const observation = await f.controller.finalize({
          harnessReady: false,
          harnessSucceeded: false,
        });
        expect(f.requests).toHaveLength(0);
        expect(observation.ready).toBe(false);
        expect(observation.failures.length).toBeGreaterThan(0);
      },
      30000,
    );

    it('retains a schema-rejected attempt that never reached the mock', async () => {
      const f = await fixture('invalid');
      const result = await runPiWithMcp(f.options);
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(0);
      expect(result.toolEvents).toEqual([
        expect.objectContaining({
          rawName: 'mcp__linear__get_issue',
          input: {unexpected: 42},
          status: 'failure',
        }),
      ]);
    }, 30000);

    it('returns mock errors to the model as plain text', async () => {
      const f = await fixture('tool-error');
      const result = await runPiWithMcp(f.options);
      expect(result.toolEvents).toEqual([
        expect.objectContaining({
          status: 'failure',
          message: 'fixture-receipt-42',
        }),
      ]);
      const messages = f.requests.at(-1)?.messages as {
        role: string;
        content: unknown;
      }[];
      expect(messages.find((message) => message.role === 'tool')?.content).toBe(
        'fixture-receipt-42',
      );
    }, 30000);

    it.each([
      {withText: false, isError: false},
      {withText: true, isError: false},
      {withText: false, isError: true},
      {withText: true, isError: true},
    ])(
      'exposes structured output to the model (text: $withText, error: $isError)',
      async ({withText, isError}) => {
        const structuredContent = {
          receipt: 'structured-receipt-42',
          ok: !isError,
        };
        const f = await fixture(isError ? 'tool-error' : 'call', {
          content: withText ? [{type: 'text', text: 'fixture-receipt-42'}] : [],
          structuredContent,
          isError,
        });
        const result = await runPiWithMcp(f.options);
        const expected = [
          ...(withText ? ['fixture-receipt-42'] : []),
          JSON.stringify(structuredContent),
        ].join('\n');
        expect(result.toolEvents?.[0]).toMatchObject({
          status: isError ? 'failure' : 'success',
          message: expect.stringContaining(JSON.stringify(structuredContent)),
        });
        if (withText)
          expect(result.toolEvents?.[0]?.message).toContain(
            'fixture-receipt-42',
          );
        const messages = f.requests.at(-1)?.messages as {
          role: string;
          content: unknown;
        }[];
        expect(
          messages.find((message) => message.role === 'tool')?.content,
        ).toBe(expected);
      },
      30000,
    );

    it('lets the model recover from a failed tool request', async () => {
      const f = await fixture('request-error');
      const result = await runPiWithMcp(f.options);
      expect(result.toolEvents?.map((event) => event.status)).toEqual([
        'failure',
        'success',
      ]);
      expect(result.toolEvents?.[0]?.message).toContain(
        'Temporary fixture failure',
      );
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(1);
    }, 30000);

    it('classifies tool-discovery failure as not ready before model execution', async () => {
      const f = await fixture('listing-failed');
      await expect(runPiWithMcp(f.options)).rejects.toMatchObject({
        category: 'not_ready',
        message: expect.stringContaining('did not activate MCP mock tool'),
      });
      expect(f.requests).toHaveLength(0);
    }, 30000);

    it.each(['- list the open issues', '@literal prompt'])(
      'passes the literal prompt %s to the model',
      async (prompt) => {
        const f = await fixture('negative');
        await runPiWithMcp({
          ...f.options,
          input: {...f.options.input, prompt},
        });
        expect(JSON.stringify(f.requests)).toContain(prompt);
      },
      30000,
    );

    it('rejects a blank prompt before starting Pi', async () => {
      const f = await fixture('negative');
      await expect(
        runPiWithMcp({
          ...f.options,
          input: {...f.options.input, prompt: '   '},
        }),
      ).rejects.toMatchObject({
        category: 'configuration_failed',
        message: 'Pi cannot run a blank prompt.',
      });
      expect(f.requests).toHaveLength(0);
    }, 30000);

    it('names a missing native MCP config loader before model execution', async () => {
      const f = await fixture('negative');
      // Pi reads its version from this directory, which lacks the MCP loader.
      // Like Pi, find the nearest package.json above the executable.
      let root = await realpath(executable!);
      do root = dirname(root);
      while (!existsSync(join(root, 'package.json')) && root !== dirname(root));
      const packageDir = join(f.root, 'relocated-pi-package');
      await mkdir(packageDir);
      await copyFile(
        join(root, 'package.json'),
        join(packageDir, 'package.json'),
      );
      await expect(
        runPiWithMcp({
          ...f.options,
          input: {
            ...f.options.input,
            env: {...f.options.input.env, PI_PACKAGE_DIR: packageDir},
          },
        }),
      ).rejects.toMatchObject({
        category: 'configuration_failed',
        message: expect.stringContaining(
          'does not include the MCP configuration loader',
        ),
      });
      expect(f.requests).toHaveLength(0);
    }, 30000);

    it('rejects tool restrictions that hide mocks before model execution', async () => {
      const f = await fixture('negative');
      await expect(
        runPiWithMcp({...f.options, extraArgs: ['--exclude-tools', 'mcp__*']}),
      ).rejects.toMatchObject({category: 'not_ready'});
      expect(f.requests).toHaveLength(0);
    }, 30000);

    it.each(['provider-retry', 'invalid-retry', 'tool-only'] as const)(
      'accepts successful completion after %s',
      async (mode) => {
        const f = await fixture(mode);
        const result = await runPiWithMcp(f.options);
        expect(result.harnessReady).toBe(true);
        const parsed = new PiHarness().extractResult(result.output);
        expect(parsed.exitCode).toBe(0);
        expect(parsed.errorMessage).toBeUndefined();
        expect(parsed.toolEvents.at(-1)?.status).toBe('success');
        if (mode === 'invalid-retry')
          expect(parsed.toolEvents.map((event) => event.status)).toEqual([
            'failure',
            'success',
          ]);
        if (mode === 'tool-only') expect(parsed.finalMessage).toBeUndefined();
      },
      30000,
    );

    it.each([['--'], ['--thinking'], ['@file'], ['extra prompt']])(
      'rejects unsafe arguments before loading inherited extensions: %j',
      async (...extraArgs) => {
        const f = await fixture('negative');
        await expect(
          runPiWithMcp({...f.options, extraArgs}),
        ).rejects.toMatchObject({
          category: 'configuration_failed',
        });
        expect(f.contacts()).toBe(0);
        expect(f.requests).toHaveLength(0);
      },
      30000,
    );

    it('keeps default project trust and user skills', async () => {
      const f = await fixture('negative');
      const result = await runPiWithMcp({
        ...f.options,
        input: {...f.options.input, permissionMode: 'default'},
      });
      expect(result.harnessReady).toBe(true);
      expect(JSON.stringify(f.requests)).toContain('Native fixture skill');
      expect(JSON.stringify(f.requests)).toContain(
        'package-fixture skill marker',
      );
      expect(JSON.stringify(f.requests)).not.toContain(
        'project-fixture skill marker',
      );
    }, 30000);

    it('bounds an unresponsive model by the execution deadline', async () => {
      const f = await fixture('hang');
      await expect(
        runPiWithMcp({
          ...f.options,
          input: {...f.options.input, timeoutMs: 2500},
        }),
      ).rejects.toMatchObject({category: 'timed_out'});
    }, 10000);

    it('keeps simultaneous sessions and controller logs independent', async () => {
      const fixtures = await Promise.all([
        fixture('call'),
        fixture('negative'),
      ]);
      const results = await Promise.all(
        fixtures.map((f) => runPiWithMcp(f.options)),
      );
      const observations = await Promise.all(
        fixtures.map((f, index) =>
          f.controller.finalize({
            harnessReady: results[index]!.harnessReady,
            harnessSucceeded: true,
          }),
        ),
      );
      expect(observations.map((value) => value.calls.length)).toEqual([1, 0]);
      for (const f of fixtures)
        await expect(fetch(f.controller.urls.linear!)).rejects.toThrow();
    }, 30000);

    it('cancels an active invocation and closes its controller routes', async () => {
      const f = await fixture('hang');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 1000);
      try {
        await expect(
          runPiWithMcp({
            ...f.options,
            input: {...f.options.input, signal: abort.signal},
          }),
        ).rejects.toMatchObject({category: 'execution_failed'});
      } finally {
        clearTimeout(timer);
      }
      const observation = await f.controller.finalize({
        harnessReady: false,
        harnessSucceeded: false,
      });
      expect(observation.ready).toBe(false);
      await expect(fetch(f.controller.urls.linear!)).rejects.toThrow();
    }, 30000);
  },
);
