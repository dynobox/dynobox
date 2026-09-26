import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';
import {afterEach, describe, expect, it} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {PiHarness} from './pi.js';
import {runPiWithMcp} from './piMcp.js';

const executable = process.env.DYNOBOX_PI_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  mode: 'call' | 'negative' | 'failed' | 'denied' | 'hang' = 'call',
  toolName = 'get_issue',
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-pi-native-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const controller = await startMcpMockController({
    linear: {
      tools: {
        [toolName]: {
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
    requests.push(body);
    if (mode === 'hang') return;
    const tool = body.tools?.find((entry: {function?: {name?: string}}) =>
      entry.function?.name?.startsWith('mcp__'),
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
              : controller.urls.linear!,
        tools: [toolName],
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
  };
}

describe.skipIf(!executable)(
  'native Pi MCP runtime (local model, no credits)',
  () => {
    it.each(['call', 'negative'] as const)(
      'runs %s with inherited servers excluded',
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
        expect(f.contacts()).toBe(0);
        for (const marker of f.markers)
          await expect(readFile(marker)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        expect(await readFile(f.configPath, 'utf8')).toBe(f.source);
        expect(f.requests.length).toBeGreaterThan(0);
        expect(JSON.stringify(f.requests)).toContain('Native fixture skill');
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
        let ready = false;
        try {
          ready = (await runPiWithMcp(f.options)).harnessReady;
        } catch {
          /* Also valid: startup rejected. */
        }
        const observation = await f.controller.finalize({
          harnessReady: ready,
          harnessSucceeded: ready,
        });
        expect(f.requests).toHaveLength(0);
        expect(observation.ready).toBe(false);
        expect(observation.failures.length).toBeGreaterThan(0);
      },
      30000,
    );

    it('rejects tool restrictions that hide mocks before model execution', async () => {
      const f = await fixture('negative');
      await expect(
        runPiWithMcp({...f.options, extraArgs: ['--tools', 'read']}),
      ).rejects.toMatchObject({category: 'not_ready'});
      expect(f.requests).toHaveLength(0);
    });

    it('calls tools whose names Pi cannot register directly', async () => {
      const f = await fixture('call', 'get.issue');
      const result = await runPiWithMcp(f.options);
      expect(result.output.metadata?.mcpRunToolEvents).toEqual([
        expect.objectContaining({rawName: 'mcp__linear__get.issue'}),
      ]);
      const observation = await f.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation).toMatchObject({
        ready: true,
        failures: [],
        calls: [{server: 'linear', tool: 'get.issue', category: 'success'}],
      });
    }, 30000);

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
