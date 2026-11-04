import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {afterEach, describe, expect, it} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {startOwnedProcess} from '../processGroup.js';
import {OpenCodeHarness} from './opencode.js';
import {runOpenCodeWithMcp} from './opencodeMcp.js';

const executable = process.env.DYNOBOX_OPENCODE_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  mode:
    | 'child-invalid'
    | 'invalid-arguments'
    | 'mock-error'
    | 'hang'
    | 'call'
    | 'negative'
    | 'failed'
    | 'denied'
    | 'ask'
    | 'ask-continue'
    | 'question'
    | 'ask-bash'
    | 'ask-subagent' = 'call',
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-native-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const controller = await startMcpMockController({
    linear: {
      tools: {
        get_issue: {
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}},
            required: ['id'],
            additionalProperties: false,
          },
          response: {
            content: [{type: 'text', text: 'fixture-receipt-42'}],
            ...(mode === 'mock-error' ? {isError: true} : {}),
          },
        },
      },
    },
  });
  cleanup.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: Record<string, unknown>[] = [];
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  let invalidSent = false;
  let realContacts = 0;
  let globalContacts = 0;
  let bashCalled = false;
  let taskCalled = false;
  const provider = createServer(async (request, response) => {
    if (request.url === '/real-mcp') {
      realContacts++;
      response.writeHead(503).end();
      return;
    }
    if (request.url === '/global-mcp') {
      globalContacts++;
      response.writeHead(503).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    modelStarted();
    if (mode === 'hang') return;
    const tool = body.tools?.find((entry: {function?: {name?: string}}) =>
      mode === 'question' || mode === 'ask-bash'
        ? entry.function?.name === (mode === 'question' ? 'question' : 'shell')
        : entry.function?.name?.endsWith('_get_issue'),
    );
    const hasReceipt = JSON.stringify(body.messages).includes(
      'fixture-receipt-42',
    );
    // The parent delegates to a subagent, which runs an `ask`-gated command.
    let delegated: {name: string; arguments: string} | undefined;
    if (mode === 'ask-subagent' || mode === 'child-invalid') {
      const names: unknown[] = (body.tools ?? []).map(
        (entry: {function?: {name?: string}}) => entry.function?.name,
      );
      const inSubagent = (
        body.messages as {role: string; content: unknown}[]
      ).some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes('SUBAGENT_RUN_TOUCH'),
      );
      if (mode === 'child-invalid' && inSubagent && !invalidSent && tool) {
        invalidSent = true;
        delegated = {
          name: tool.function.name,
          arguments: '{"id":{"bad":true}}',
        };
      } else if (
        mode === 'ask-subagent' &&
        inSubagent &&
        !bashCalled &&
        names.includes('shell')
      ) {
        bashCalled = true;
        delegated = {
          name: 'shell',
          arguments: JSON.stringify({
            command: 'touch bash-ran',
            description: 'Mark the run',
          }),
        };
      } else if (!inSubagent && !taskCalled && names.includes('subagent')) {
        taskCalled = true;
        delegated = {
          name: 'subagent',
          arguments: JSON.stringify({
            description: 'Mark the run',
            prompt: 'SUBAGENT_RUN_TOUCH',
            agent: 'general',
          }),
        };
      }
    }
    const call =
      delegated !== undefined ||
      ((mode === 'call' ||
        mode === 'mock-error' ||
        (mode === 'invalid-arguments' && !invalidSent) ||
        mode === 'ask' ||
        mode === 'ask-continue' ||
        mode === 'question' ||
        (mode === 'ask-bash' && !bashCalled)) &&
        !hasReceipt &&
        !!tool &&
        requests.length < 10);
    if (call && mode === 'invalid-arguments') invalidSent = true;
    if (call && mode === 'ask-bash') bashCalled = true;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_fixture',
              type: 'function',
              function: delegated ?? {
                name: tool?.function.name ?? 'missing',
                arguments:
                  mode === 'question'
                    ? '{"questions":[{"question":"Which issue?","header":"Issue","options":[{"label":"DYNO-1","description":"First"}]}]}'
                    : mode === 'ask-bash'
                      ? JSON.stringify({
                          command: 'touch bash-ran',
                          description: 'Mark the run',
                        })
                      : mode === 'invalid-arguments'
                        ? '{"id":{"bad":true}}'
                        : '{"id":"DYNO-1"}',
              },
            },
          ],
        }
      : {content: hasReceipt ? 'fixture-receipt-42' : 'No calls needed.'};
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
  const marker = join(root, 'real-started');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    providers: {
      fixture: {
        package: '@opencode/ai/providers/openai-compatible',
        name: 'Fixture',
        settings: {baseURL: `${base}/v1`, apiKey: 'synthetic'},
        models: {
          fixture: {
            name: 'Fixture',
            variants: [{id: 'fast'}],
            capabilities: {tools: true},
            limit: {context: 32000, output: 1000},
          },
        },
      },
    },
    mcp: {
      servers: {
        real_linear: {
          type: 'local',
          command: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
          ],
        },
        remote: {type: 'remote', url: `${base}/real-mcp`, oauth: false},
      },
    },
    ...(mode === 'denied'
      ? {
          permissions: [
            {action: 'linear_get_issue', resource: '*', effect: 'deny'},
          ],
        }
      : {}),
    ...(mode === 'ask' || mode === 'ask-continue'
      ? {
          permissions: [
            {action: 'linear_get_issue', resource: '*', effect: 'ask'},
          ],
        }
      : {}),
    ...(mode === 'ask-bash' || mode === 'ask-subagent'
      ? {permissions: [{action: 'shell', resource: '*', effect: 'ask'}]}
      : {}),
    // The model keeps going after a denial and can still finish with "stop".
    ...(mode === 'ask-continue'
      ? {experimental: {continue_loop_on_deny: true}}
      : {}),
  };
  const configPath = join(root, 'opencode.json');
  const source = JSON.stringify(config);
  await writeFile(configPath, source);
  const globalConfigPath = join(root, 'config', 'opencode', 'opencode.json');
  const globalSource = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      servers: {
        global: {type: 'remote', url: `${base}/global-mcp`, oauth: false},
      },
    },
  });
  await mkdir(join(root, 'config', 'opencode'), {recursive: true});
  await writeFile(globalConfigPath, globalSource);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
  };
  await mkdir(join(root, '.agents', 'skills', 'fixture'), {recursive: true});
  await writeFile(
    join(root, '.agents', 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: Native fixture skill\n---\nSay fixture.\n',
  );
  const pluginMarkers = [
    join(root, 'project-plugin-loaded'),
    join(root, 'global-plugin-loaded'),
  ];
  for (const [directory, marker] of [
    [join(root, '.opencode', 'plugins'), pluginMarkers[0]!],
    [join(root, 'config', 'opencode', 'plugins'), pluginMarkers[1]!],
  ] as const) {
    await mkdir(join(directory, 'probe'), {recursive: true});
    await writeFile(
      join(directory, 'probe', 'package.json'),
      JSON.stringify({type: 'module'}),
    );
    await writeFile(
      join(directory, 'probe', 'server.js'),
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default {id: 'probe_${pluginMarkers.indexOf(marker)}', setup() {}};`,
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
          mode === 'failed'
            ? `http://127.0.0.1:1/${'a'.repeat(48)}`
            : controller.urls.linear!,
        tools: ['get_issue'],
      },
    },
  };
  return {
    options,
    started,
    controller,
    requests,
    marker,
    configPath,
    source,
    globalConfigPath,
    globalSource,
    pluginMarkers,
    contacts: () => realContacts,
    globalContacts: () => globalContacts,
  };
}

describe.skipIf(!executable)(
  'native OpenCode MCP runtime (local model, no credits)',
  () => {
    it('loads the planted v2 plugins without the adapter block', async () => {
      const f = await fixture('negative');
      const child = startOwnedProcess(
        executable!,
        ['serve', '--hostname', '127.0.0.1', '--port', '0'],
        {
          cwd: f.options.input.workDir,
          env: {
            ...f.options.input.env,
            OPENCODE_PASSWORD: 'fixture-control',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              policies: [
                {action: 'integration.use', resource: 'mcp:*', effect: 'deny'},
              ],
            }),
          },
          stdin: 'ignore',
          reject: false,
          timeout: 10000,
        },
      );
      try {
        const base = await new Promise<string>((resolve, reject) => {
          let output = '';
          child.stdout?.on('data', (chunk) => {
            output += String(chunk);
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+(?=\s)/);
            if (match) resolve(match[0]);
          });
          child.then(() => reject(new Error('control server exited')), reject);
        });
        const response = await fetch(`${base}/api/plugin`, {
          headers: {
            Authorization: `Basic ${Buffer.from('opencode:fixture-control').toString('base64')}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        for (
          let attempt = 0;
          attempt < 30 && !f.pluginMarkers.every(existsSync);
          attempt++
        )
          await delay(100);
        for (const marker of f.pluginMarkers)
          expect(await readFile(marker, 'utf8')).toBe('loaded');
      } finally {
        child.stop();
        await child;
      }
    }, 15000);

    it.each(['call', 'negative'] as const)(
      'runs %s with inherited servers excluded',
      async (mode) => {
        const f = await fixture(mode);
        const result = await runOpenCodeWithMcp(f.options);
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
          new OpenCodeHarness().extractResult(result.output).finalMessage,
        ).toContain(
          mode === 'call' ? 'fixture-receipt-42' : 'No calls needed.',
        );
        expect(f.contacts()).toBe(0);
        expect(f.globalContacts()).toBe(0);
        await expect(readFile(f.marker)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        for (const marker of f.pluginMarkers)
          await expect(readFile(marker)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        expect(await readFile(f.configPath, 'utf8')).toBe(f.source);
        expect(await readFile(f.globalConfigPath, 'utf8')).toBe(f.globalSource);
        expect(f.requests.length).toBeGreaterThan(0);
        expect(JSON.stringify(f.requests)).toContain('Native fixture skill');
        if (mode === 'call') {
          expect(result.toolEvents).toEqual([
            expect.objectContaining({
              rawName: 'mcp__linear__get_issue',
              kind: 'mcp',
            }),
          ]);
        }
      },
      30000,
    );

    it.each(['integration.use', 'plugin.use', 'mcp.use', '*', 'integration.*'])(
      'rejects global %s allow policy before inherited integrations load',
      async (action) => {
        const f = await fixture('call');
        await writeFile(
          f.globalConfigPath,
          JSON.stringify({
            policies: [{action, resource: '*', effect: 'allow'}],
          }),
        );
        await expect(runOpenCodeWithMcp(f.options)).rejects.toMatchObject({
          category: 'configuration_failed',
          message: expect.stringContaining('can override MCP mock isolation'),
        });
        expect(f.requests).toHaveLength(0);
        expect(f.contacts()).toBe(0);
        expect(f.globalContacts()).toBe(0);
        for (const marker of f.pluginMarkers)
          expect(existsSync(marker)).toBe(false);
      },
      30000,
    );

    it.each(Array.from({length: 10}, (_, index) => index))(
      'keeps direct mock tools available after discovery (iteration %i)',
      async () => {
        const f = await fixture('call');
        const result = await runOpenCodeWithMcp(f.options);
        const observation = await f.controller.finalize({
          harnessReady: result.harnessReady,
          harnessSucceeded: true,
        });
        expect(observation.calls).toHaveLength(1);
        expect(result.toolEvents).toContainEqual(
          expect.objectContaining({
            rawName: 'mcp__linear__get_issue',
            status: 'success',
          }),
        );
      },
      30000,
    );

    it('does not let failed startup pass a negative assertion', async () => {
      const f = await fixture('failed');
      let ready = false;
      try {
        ready = (await runOpenCodeWithMcp(f.options)).harnessReady;
      } catch {
        /* Also valid: startup rejected. */
      }
      const observation = await f.controller.finalize({
        harnessReady: ready,
        harnessSucceeded: ready,
      });
      expect(observation.ready).toBe(false);
      expect(observation.failures.length).toBeGreaterThan(0);
    }, 30000);

    it('preserves logical tool denials before model execution', async () => {
      const f = await fixture('denied');
      await expect(runOpenCodeWithMcp(f.options)).rejects.toMatchObject({
        category: 'not_ready',
      });
      expect(f.requests).toHaveLength(0);
    }, 30000);

    it.each(['ask', 'ask-continue'] as const)(
      'fails a %s run whose mock call is rejected instead of waiting',
      async (mode) => {
        const f = await fixture(mode);
        await expect(
          runOpenCodeWithMcp({
            ...f.options,
            input: {...f.options.input, permissionMode: 'default'},
          }),
        ).rejects.toMatchObject({
          category: 'execution_failed',
          message: expect.stringContaining(
            'rejected permission for a mock tool',
          ),
        });
        const observation = await f.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        });
        expect(observation.calls).toHaveLength(0);
      },
      30000,
    );

    it.each(['dangerous', 'default'] as const)(
      'does not offer the question tool in %s mode, which would wait for an answer',
      async (permissionMode) => {
        const f = await fixture('question');
        const result = await runOpenCodeWithMcp({
          ...f.options,
          input: {...f.options.input, permissionMode, timeoutMs: 15_000},
        });
        expect(result.harnessReady).toBe(true);
        expect(JSON.stringify(f.requests)).not.toContain('"name":"question"');
      },
      30000,
    );

    it('runs when the user environment sets an OpenCode server password', async () => {
      const f = await fixture('negative');
      const result = await runOpenCodeWithMcp({
        ...f.options,
        input: {
          ...f.options.input,
          env: {...f.options.input.env, OPENCODE_SERVER_PASSWORD: 'secret'},
        },
      });
      expect(result.harnessReady).toBe(true);
    }, 30000);

    it.each([
      ['default', false],
      ['dangerous', true],
    ] as const)(
      'treats an "ask" rule for a non-mock tool like opencode run in %s mode',
      async (permissionMode, runs) => {
        const f = await fixture('ask-bash');
        const result = await runOpenCodeWithMcp({
          ...f.options,
          input: {...f.options.input, permissionMode},
        });
        expect(result.harnessReady).toBe(true);
        // Default mode rejects the command; dangerous mode approves it.
        expect(existsSync(join(f.options.input.workDir, 'bash-ran'))).toBe(
          runs,
        );
      },
      30000,
    );

    it('approves a subagent "ask" in dangerous mode like opencode run --auto', async () => {
      const f = await fixture('ask-subagent');
      const result = await runOpenCodeWithMcp({
        ...f.options,
        input: {...f.options.input, permissionMode: 'dangerous'},
      });
      expect(result.harnessReady).toBe(true);
      expect(existsSync(join(f.options.input.workDir, 'bash-ran'))).toBe(true);
    }, 30000);

    it('runs a mock tool with normal permissions', async () => {
      const f = await fixture('call');
      const result = await runOpenCodeWithMcp({
        ...f.options,
        input: {...f.options.input, permissionMode: 'default'},
      });
      const observation = await f.controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      expect(observation).toMatchObject({ready: true, failures: []});
      expect(observation.calls).toHaveLength(1);
      expect(f.contacts()).toBe(0);
      expect(f.globalContacts()).toBe(0);
    }, 30000);

    it('keeps simultaneous sessions and controller logs independent', async () => {
      const fixtures = await Promise.all([
        fixture('call'),
        fixture('negative'),
      ]);
      const results = await Promise.all(
        fixtures.map((f) => runOpenCodeWithMcp(f.options)),
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
      const pending = runOpenCodeWithMcp({
        ...f.options,
        input: {...f.options.input, signal: abort.signal},
      });
      const rejected = expect(pending).rejects.toMatchObject({
        category: 'execution_failed',
      });
      await f.started;
      abort.abort();
      await rejected;
      const observation = await f.controller.finalize({
        harnessReady: false,
        harnessSucceeded: false,
      });
      expect(observation.ready).toBe(false);
      await expect(fetch(f.controller.urls.linear!)).rejects.toThrow();
    }, 30000);

    it('keeps an invalid mock attempt in the evidence when no call reaches the mock', async () => {
      const f = await fixture('invalid-arguments');
      const result = await runOpenCodeWithMcp(f.options);
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(0);
      expect(result.toolEvents).toContainEqual(
        expect.objectContaining({
          rawName: 'mcp__linear__get_issue',
          status: 'failure',
        }),
      );
    }, 30000);

    it('runs with a model variant', async () => {
      const f = await fixture('call');
      f.options.input.model = 'fixture/fixture#fast';
      const result = await runOpenCodeWithMcp(f.options);
      expect(result.harnessReady).toBe(true);
    }, 30000);

    it('includes an invalid mock attempt from a subagent', async () => {
      const f = await fixture('child-invalid');
      const result = await runOpenCodeWithMcp(f.options);
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(0);
      expect(result.toolEvents).toContainEqual(
        expect.objectContaining({
          rawName: 'mcp__linear__get_issue',
          status: 'failure',
        }),
      );
    }, 30000);

    it('retains a received mock error as call evidence', async () => {
      const f = await fixture('mock-error');
      const result = await runOpenCodeWithMcp(f.options);
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation.calls).toHaveLength(1);
      expect(observation.calls[0]?.category).toBe('tool_error');
      expect(result.toolEvents).toContainEqual(
        expect.objectContaining({
          rawName: 'mcp__linear__get_issue',
          status: 'failure',
          message: expect.stringContaining('fixture-receipt-42'),
        }),
      );
    }, 30000);

    it('applies an explicit grant after inherited wildcard ask rules', async () => {
      const f = await fixture('call');
      await writeFile(
        f.globalConfigPath,
        JSON.stringify({
          permissions: [
            {action: 'linear_get_issue', resource: '*', effect: 'ask'},
            {action: 'linear_*', resource: '*', effect: 'ask'},
          ],
        }),
      );
      const result = await runOpenCodeWithMcp({
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
      expect(observation.calls).toHaveLength(1);
    }, 30000);
  },
);
