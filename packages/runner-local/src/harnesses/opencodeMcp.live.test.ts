import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';
import {afterEach, describe, expect, it} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {OpenCodeHarness} from './opencode.js';
import {runOpenCodeWithMcp} from './opencodeMcp.js';

const executable = process.env.DYNOBOX_OPENCODE_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  mode: 'call' | 'negative' | 'failed' | 'denied' = 'call',
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-native-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const controller = await startMcpMockController({
    linear: {
      tools: {
        get_issue: {
          inputSchema: {type: 'object'},
          response: {content: [{type: 'text', text: 'fixture-receipt-42'}]},
        },
      },
    },
  });
  cleanup.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  const requests: Record<string, unknown>[] = [];
  let realContacts = 0;
  const provider = createServer(async (request, response) => {
    if (request.url === '/real-mcp') {
      realContacts++;
      response.writeHead(503).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const tool = body.tools?.find((entry: {function?: {name?: string}}) =>
      entry.function?.name?.endsWith('_get_issue'),
    );
    const hasReceipt = JSON.stringify(body.messages).includes(
      'fixture-receipt-42',
    );
    const call =
      mode === 'call' && !hasReceipt && !!tool && requests.length < 10;
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_fixture',
              type: 'function',
              function: {
                name: tool?.function.name ?? 'missing',
                arguments: '{"id":"DYNO-1"}',
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
    provider: {
      fixture: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fixture',
        options: {baseURL: `${base}/v1`, apiKey: 'synthetic'},
        models: {
          fixture: {name: 'Fixture', limit: {context: 32000, output: 1000}},
        },
      },
    },
    mcp: {
      linear: {
        type: 'local',
        command: [
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
        ],
      },
      remote: {type: 'remote', url: `${base}/real-mcp`, oauth: false},
    },
    ...(mode === 'denied' ? {permission: {linear_get_issue: 'deny'}} : {}),
  };
  const configPath = join(root, 'opencode.json');
  const source = JSON.stringify(config);
  await writeFile(configPath, source);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: root,
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
  };
  await mkdir(join(root, '.agents', 'skills', 'fixture'), {recursive: true});
  await writeFile(
    join(root, '.agents', 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: Native fixture skill\n---\nSay fixture.\n',
  );
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
    controller,
    requests,
    marker,
    configPath,
    source,
    contacts: () => realContacts,
  };
}

describe.skipIf(!executable)(
  'native OpenCode MCP runtime (local model, no credits)',
  () => {
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
        await expect(readFile(f.marker)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(f.configPath, 'utf8')).toBe(f.source);
        expect(f.requests.length).toBeGreaterThan(0);
        expect(JSON.stringify(f.requests)).toContain('Native fixture skill');
        if (mode === 'call') {
          expect(result.output.metadata?.mcpRunToolEvents).toEqual([
            expect.objectContaining({
              rawName: 'mcp__linear__get_issue',
              kind: 'mcp',
            }),
          ]);
          await execa(executable!, ['--pure', 'mcp', 'list'], {
            cwd: f.options.input.workDir,
            env: f.options.input.env,
            timeout: 10000,
            reject: false,
          });
          expect(f.contacts()).toBeGreaterThan(0);
          expect(await readFile(f.marker, 'utf8')).toBe('started');
        }
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
      const f = await fixture('negative');
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 1000);
      try {
        await expect(
          runOpenCodeWithMcp({
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
