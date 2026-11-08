import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createServer, type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';

import {execa} from 'execa';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {runJob} from '../index.js';
import {startMcpMockController} from '../mcpMocks/controller.js';
import type {LocalRunnerJob} from '../runTypes.js';
import {CursorHarness} from './cursor.js';
import {runCursorWithMcp} from './cursorMcp.js';

const executable = process.env.DYNOBOX_CURSOR_MCP_EXECUTABLE;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Minimal test-only protobuf/Connect envelopes for the installed CLI backend.
// Field numbers are pinned to the native runtime version tested by this suite.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}
function field(number: number, value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function fields(bytes: Buffer = Buffer.alloc(0)): Map<number, Buffer[]> {
  let index = 0;
  const read = () => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      byte = bytes[index++]!;
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const result = new Map<number, Buffer[]>();
  while (index < bytes.length) {
    const tag = read(),
      number = tag >>> 3,
      wire = tag & 7;
    if (wire === 2) {
      const length = read(),
        value = bytes.subarray(index, index + length);
      index += length;
      result.set(number, [...(result.get(number) ?? []), value]);
    } else if (wire === 0) read();
    else if (wire === 1) index += 8;
    else if (wire === 5) index += 4;
    else throw new Error('Unexpected fixture protobuf wire type.');
  }
  return result;
}
function frame(data: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

async function fixture(
  mode: 'call' | 'negative' | 'hang' | 'error' = 'call',
  toolError = false,
) {
  for (const key of Object.keys(process.env))
    if (
      /^(CURSOR_|AGENT_CLI_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)/.test(
        key,
      )
    )
      vi.stubEnv(key, undefined);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dynobox-cursor-native-')),
  );
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const work = join(root, 'workspace'),
    profile = join(root, '.cursor');
  await mkdir(join(work, '.cursor'), {recursive: true});
  await mkdir(profile);
  const definitions = {
    linear: {
      instructions: 'MOCK_SERVER_INSTRUCTIONS',
      tools: {
        get_issue: {
          inputSchema: {
            type: 'object',
            properties: {id: {type: 'string'}},
            required: ['id'],
          },
          response: {
            content: [{type: 'text' as const, text: 'fixture-receipt-42'}],
            ...(toolError ? {isError: true} : {}),
          },
        },
      },
    },
  };
  const controller = await startMcpMockController(definitions);
  cleanup.push(() =>
    controller.finalize({harnessReady: false, harnessSucceeded: false}),
  );
  let originals = 0;
  let healthyOriginal = false;
  let failAfterProbe = false;
  let listings = 0;
  let stream: ServerResponse | undefined;
  let call: Buffer;
  let requests = 0;
  let selectedServer: string | undefined;
  let disabledContacts = 0;
  const taskBoundaries: boolean[] = [];
  const contexts: string[] = [],
    modelHeaders: (string | undefined)[] = [],
    receipts: string[] = [],
    mockHeaders: (string | undefined)[] = [];
  const model = Buffer.concat([
    field(1, 'gpt-5'),
    field(3, 'gpt-5'),
    field(4, 'Fixture GPT'),
    field(5, 'Fixture GPT'),
  ]);
  const update = (number: number, result?: Buffer) =>
    field(
      1,
      field(
        number,
        Buffer.concat([
          field(1, 'call-fixture'),
          field(
            2,
            field(
              15,
              Buffer.concat([
                field(1, call),
                ...(result ? [field(2, result)] : []),
              ]),
            ),
          ),
        ]),
      ),
    );
  const finish = () => {
    stream!.write(frame(field(1, field(1, field(1, 'fixture complete.')))));
    stream!.write(frame(field(1, field(14, Buffer.alloc(0)))));
    stream!.end(frame(Buffer.from('{}'), 2));
    stream = undefined;
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/disabled-other') {
      disabledContacts++;
      response.writeHead(503).end();
      return;
    }
    if (request.url === '/original-mcp') {
      originals++;
      if (!healthyOriginal) {
        response.writeHead(503).end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        rpc.method === 'initialize'
          ? {
              protocolVersion: rpc.params.protocolVersion,
              capabilities: {tools: {}},
              serverInfo: {name: 'original', version: '1'},
            }
          : rpc.method === 'tools/list'
            ? {tools: [{name: 'get_issue', inputSchema: {type: 'object'}}]}
            : {content: [{type: 'text', text: 'original-receipt'}]};
      response
        .writeHead(200, {'content-type': 'application/json'})
        .end(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result}));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body =
      request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
    const path = request.url ?? '';
    if (path === '/mock-proxy') {
      mockHeaders.push(request.headers.authorization);
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const rpc = JSON.parse(body.toString());
      if (rpc.method === 'tools/list' && ++listings > 1 && failAfterProbe) {
        response.writeHead(200, {'content-type': 'application/json'}).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: {
              code: -32603,
              message: 'Synthetic task discovery failure',
            },
          }),
        );
        return;
      }
      const forwarded = await fetch(controller.urls.linear!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      });
      response
        .writeHead(forwarded.status, {
          'content-type':
            forwarded.headers.get('content-type') ?? 'application/json',
        })
        .end(Buffer.from(await forwarded.arrayBuffer()));
      return;
    }
    if (path.endsWith('/BidiAppend') && stream) {
      const data = fields(body).get(1)?.[0]?.toString() ?? '';
      const client = fields(Buffer.from(data, 'hex'));
      const execution = fields(client.get(2)?.[0]);
      const contextResult = execution.get(10)?.[0];
      if (contextResult) {
        const context = fields(fields(contextResult).get(1)?.[0]).get(1)?.[0];
        contexts.push(context?.toString() ?? '');
        if (mode === 'negative') finish();
        else {
          const native =
            selectedServer ??
            context?.toString().match(/dxb_[a-f0-9]{20}/)?.[0];
          const identifier =
            selectedServer ??
            context
              ?.toString()
              .match(/plugin-dxb_plugin_[a-f0-9]{12}-dxb_[a-f0-9]{20}/)?.[0];
          if (!native || !identifier)
            throw new Error('Native context did not expose the mock server.');
          call = Buffer.concat([
            field(1, 'get_issue'),
            field(
              2,
              Buffer.concat([field(1, 'id'), field(2, field(3, 'ENG-42'))]),
            ),
            field(3, 'call-fixture'),
            field(4, native),
            field(5, 'get_issue'),
            field(9, identifier),
          ]);
          stream.write(frame(update(2)));
          stream.write(
            frame(
              field(
                2,
                Buffer.concat([
                  Buffer.from([8, 2]),
                  field(15, 'exec-fixture'),
                  field(11, call),
                ]),
              ),
            ),
          );
        }
      }
      const result = execution.get(11)?.[0];
      if (result) {
        receipts.push(result.toString());
        stream!.write(frame(update(3, result)));
        finish();
      }
    }
    if (
      path.endsWith('/GetUsableModels') ||
      path.endsWith('/GetDefaultModelForCli')
    )
      response
        .writeHead(200, {'content-type': 'application/proto'})
        .end(field(1, model));
    else if (path.endsWith('/RunSSE')) {
      requests++;
      taskBoundaries.push(
        await readFile(join(work, '.git')).then(
          () => true,
          () => false,
        ),
      );
      modelHeaders.push(request.headers.authorization);
      stream = response;
      response.writeHead(200, {'content-type': 'application/connect+proto'});
      if (mode === 'hang') return;
      if (mode === 'error') {
        response.end(
          frame(
            Buffer.from(
              JSON.stringify({
                error: {
                  code: 'invalid_argument',
                  message: 'Synthetic provider failure',
                },
              }),
            ),
            2,
          ),
        );
        stream = undefined;
      } else
        response.write(
          frame(
            field(
              2,
              Buffer.concat([
                Buffer.from([8, 1]),
                field(15, 'context-fixture'),
                field(10, Buffer.alloc(0)),
              ]),
            ),
          ),
        );
    } else response.writeHead(200, {'content-type': 'application/proto'}).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port.');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const token = [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from('{"sub":"synthetic-cursor-user","exp":9999999999}').toString(
      'base64url',
    ),
    '',
  ].join('.');
  await writeFile(
    join(profile, 'cli-config.json'),
    JSON.stringify({
      version: 1,
      editor: {vimMode: false},
      permissions: {allow: [], deny: []},
      network: {useHttp1ForAgent: true},
    }),
  );
  await writeFile(
    join(profile, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        linear: {
          url: endpoint + '/original-mcp',
          headers: {Authorization: 'Bearer original-target-synthetic'},
        },
      },
    }),
  );
  const paths = [
    join(work, '.cursor', 'mcp.json'),
    join(work, '.cursor', 'cli.json'),
  ];
  await writeFile(
    paths[0]!,
    '{"mcpServers":{"linear":{"url":"' + endpoint + '/original-mcp"}}}\n',
  );
  await writeFile(
    paths[1]!,
    '{"permissions":{"allow":["Read(src/**)"],"deny":[]}}\n',
  );
  await mkdir(join(profile, 'skills', 'fixture-skill'), {recursive: true});
  await writeFile(
    join(profile, 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: PROFILE_SKILL_MARKER\n---\nRead fixture files.\n',
  );
  const options = {
    executable: executable!,
    input: {
      prompt: 'Use the Linear tool and report the receipt.',
      workDir: work,
      model: 'gpt-5',
      timeoutMs: 20000,
      env: {
        HOME: root,
        CURSOR_CONFIG_DIR: profile,
        CURSOR_AUTH_TOKEN: token,
        CURSOR_API_ENDPOINT: endpoint,
        AGENT_CLI_CREDENTIAL_STORE: 'file',
        CURSOR_DISABLE_TELEMETRY: '1',
      },
    },
    servers: {
      linear: {
        url: endpoint + '/mock-proxy',
        tools: ['get_issue'],
        isDiscovered: () => controller.isDiscovered('linear'),
        discoveryCount: () => controller.discoveryCount('linear'),
      },
    },
  };
  return {
    root,
    work,
    profile,
    controller,
    options,
    definitions,
    paths,
    contexts,
    receipts,
    modelHeaders,
    mockHeaders,
    token,
    selectServer: (server: string) => {
      selectedServer = server;
    },
    useHealthyOriginal: () => {
      healthyOriginal = true;
    },
    failTaskDiscovery: () => {
      failAfterProbe = true;
    },
    originals: () => originals,
    requests: () => requests,
    disabledContacts: () => disabledContacts,
    taskBoundaries,
  };
}

describe.skipIf(!executable)(
  'native Cursor MCP runtime (local backend, no credits)',
  () => {
    it('replaces HTTP targets, preserves logical callbacks, auth and skills, and restores workspace files', async () => {
      const f = await fixture();
      const paths = [...f.paths, join(f.profile, 'mcp.json')];
      const originals = await Promise.all(
        paths.map((path) => readFile(path, 'utf8')),
      );
      const live: string[] = [];
      const result = await runCursorWithMcp({
        ...f.options,
        input: {
          ...f.options.input,
          onToolEvent: (event) => live.push(event.rawName),
        },
      });
      const evidence = await f.controller.finalize({
        harnessReady: result.harnessReady,
        harnessSucceeded: true,
      });
      expect(evidence).toMatchObject({
        ready: true,
        failures: [],
        calls: [{server: 'linear', tool: 'get_issue', input: {id: 'ENG-42'}}],
      });
      expect(result.toolEvents).toMatchObject([
        {
          kind: 'mcp',
          rawName: 'mcp__linear__get_issue',
          input: {id: 'ENG-42'},
          status: 'success',
        },
      ]);
      expect(live).toEqual(['mcp__linear__get_issue']);
      expect(
        new CursorHarness().extractResult(result.output).toolEvents,
      ).toEqual(result.toolEvents);
      expect(f.originals()).toBe(0);
      expect(f.receipts.join('')).toContain('fixture-receipt-42');
      expect(f.contexts.join('')).toContain('PROFILE_SKILL_MARKER');
      expect(f.contexts.join('')).toContain('MOCK_SERVER_INSTRUCTIONS');
      expect(f.modelHeaders).toEqual(['Bearer ' + f.token]);
      expect(f.mockHeaders.length).toBeGreaterThan(0);
      expect(f.mockHeaders.every((header) => header === undefined)).toBe(true);
      expect(
        await Promise.all(paths.map((path) => readFile(path, 'utf8'))),
      ).toEqual(originals);
    }, 30000);

    it.each(['call', 'negative', 'unrelated'] as const)(
      'supports public runJob %s assertions',
      async (mode) => {
        const f = await fixture(mode === 'negative' ? 'negative' : 'call');
        let other:
          | Awaited<ReturnType<typeof startMcpMockController>>
          | undefined;
        if (mode === 'unrelated') {
          other = await startMcpMockController({other: f.definitions.linear});
          cleanup.push(() =>
            other!.finalize({harnessReady: false, harnessSucceeded: false}),
          );
          const path = join(f.profile, 'mcp.json');
          const config = JSON.parse(await readFile(path, 'utf8'));
          config.mcpServers.other = {url: other.urls.other};
          await writeFile(path, JSON.stringify(config));
          const settings = join(f.profile, 'cli-config.json');
          const permissions = JSON.parse(await readFile(settings, 'utf8'));
          permissions.permissions.allow.push('Mcp(other:get_issue)');
          await writeFile(settings, JSON.stringify(permissions));
          f.selectServer('other');
        }
        const job: LocalRunnerJob = {
          id: 'native-cursor',
          harness: 'cursor',
          model: 'gpt-5',
          permissionMode: 'default',
          iteration: 0,
          scenario: {
            id: 'receipt',
            name: 'Read a receipt',
            prompt: f.options.input.prompt,
            harnesses: [{id: 'cursor'}],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            mcpMocks: f.definitions,
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
          harnesses: [new CursorHarness({executable: executable!})],
          scratchRoot: f.root,
          env: f.options.input.env,
          allowUnmockedMcp: true,
          timeoutMs: 20000,
        });
        expect(
          result.status,
          result.diagnostics.join('\n') + '\n' + result.harnessOutput?.stderr,
        ).toBe('passed');
        expect(result.mcp).toMatchObject({ready: true, failures: []});
        expect(result.mcp?.calls).toHaveLength(mode === 'call' ? 1 : 0);
        expect(f.originals()).toBe(0);
        if (other)
          expect(
            (await other.finalize({harnessReady: true, harnessSucceeded: true}))
              .calls,
            f.receipts.join('\n'),
          ).toHaveLength(1);
      },
      30000,
    );

    it('requires discovery for a successful no-call run', async () => {
      const f = await fixture('negative');
      const result = await runCursorWithMcp(f.options);
      expect(result.toolEvents).toEqual([]);
      expect(
        await f.controller.finalize({
          harnessReady: result.harnessReady,
          harnessSucceeded: true,
        }),
      ).toMatchObject({ready: true, calls: [], failures: []});
      expect(f.originals()).toBe(0);
      expect(f.requests()).toBe(1);
    }, 30000);

    it('rejects a missing declared tool before starting the task', async () => {
      const f = await fixture('negative');
      await expect(
        runCursorWithMcp({
          ...f.options,
          servers: {
            linear: {
              ...f.options.servers.linear,
              tools: ['get_issue', 'missing_tool'],
            },
          },
        }),
      ).rejects.toMatchObject({category: 'not_ready'});
      expect(f.controller.isDiscovered('linear')).toBe(true);
      expect(f.requests()).toBe(0);
      expect(f.originals()).toBe(0);
    }, 30000);

    it.each(['call', 'negative'] as const)(
      'rejects a native deny rule before a %s task',
      async (mode) => {
        const f = await fixture(mode);
        await rm(join(f.work, '.cursor', 'cli.json'));
        const path = join(f.profile, 'cli-config.json');
        const config = JSON.parse(await readFile(path, 'utf8'));
        config.permissions.deny.push('Mcp(*:*)');
        await writeFile(path, JSON.stringify(config));
        await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
          category: 'configuration_failed',
          message: expect.stringContaining('linear.get_issue'),
        });
        expect(f.requests()).toBe(0);
        expect(f.originals()).toBe(0);
      },
      30000,
    );

    it('does not pass a public negative assertion when inherited policy denies mocks', async () => {
      const f = await fixture('negative');
      const path = join(f.profile, 'cli-config.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      config.permissions.deny.push('Mcp(*:*)');
      await writeFile(path, JSON.stringify(config));
      const job: LocalRunnerJob = {
        id: 'native-cursor-policy',
        harness: 'cursor',
        model: 'gpt-5',
        iteration: 0,
        scenario: {
          id: 'receipt',
          name: 'No calls',
          prompt: 'Reply.',
          harnesses: [{id: 'cursor'}],
          setup: [],
          fixtures: [],
          cliMocks: {},
          endpoints: [],
          mcpMocks: f.definitions,
          assertions: [
            {
              id: 'receipt',
              type: 'mcp.notCalled',
              server: 'linear',
              tool: 'get_issue',
            },
          ],
        },
      };
      const result = await runJob(job, {
        harnesses: [new CursorHarness({executable: executable!})],
        scratchRoot: f.root,
        env: f.options.input.env,
        allowUnmockedMcp: true,
        timeoutMs: 20000,
      });
      expect(result.status).toBe('harness_failed');
      expect(result.mcp?.ready).toBe(false);
      expect(result.diagnostics.join('\n')).toContain('linear.get_issue');
      expect(f.requests()).toBe(0);
    }, 30000);

    it('runs a nested Git workspace without changing its task Git context', async () => {
      const f = await fixture();
      await execa('git', ['init', '--quiet', f.root]);
      await writeFile(f.paths[1]!, '{}');
      await writeFile(
        join(f.root, '.cursor', 'cli.json'),
        JSON.stringify({
          permissions: {
            allow: ['Read(parent/**)'],
            deny: ['Mcp(*:dangerous_tool)'],
          },
        }),
      );
      const result = await runCursorWithMcp(f.options);
      expect(result.harnessReady).toBe(true);
      expect(
        (
          await f.controller.finalize({
            harnessReady: true,
            harnessSucceeded: true,
          })
        ).calls,
      ).toHaveLength(1);
      expect(f.originals()).toBe(0);
      expect(f.taskBoundaries).toEqual([false]);
      expect(
        (await execa('git', ['rev-parse', '--show-toplevel'], {cwd: f.work}))
          .stdout,
      ).toBe(f.root);
      await expect(readFile(join(f.work, '.git'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }, 30000);

    it('runs a public job with scratchRoot inside a checkout', async () => {
      const f = await fixture();
      await execa('git', ['init', '--quiet', f.root]);
      const job: LocalRunnerJob = {
        id: 'native-cursor-nested',
        harness: 'cursor',
        model: 'gpt-5',
        iteration: 0,
        scenario: {
          id: 'receipt',
          name: 'Read receipt',
          prompt: f.options.input.prompt,
          harnesses: [{id: 'cursor'}],
          setup: [],
          fixtures: [],
          cliMocks: {},
          endpoints: [],
          mcpMocks: f.definitions,
          assertions: [
            {
              id: 'receipt',
              type: 'mcp.called',
              server: 'linear',
              tool: 'get_issue',
            },
          ],
        },
      };
      const result = await runJob(job, {
        harnesses: [new CursorHarness({executable: executable!})],
        scratchRoot: f.root,
        env: f.options.input.env,
        allowUnmockedMcp: true,
        timeoutMs: 20000,
      });
      expect(
        result.status,
        result.diagnostics.join('\n') + '\n' + result.harnessOutput?.stderr,
      ).toBe('passed');
      expect(result.mcp?.calls).toHaveLength(1);
      expect(f.originals()).toBe(0);
      await expect(
        readFile(join(result.workDir, '.git')),
      ).rejects.toMatchObject({code: 'ENOENT'});
    }, 30000);

    it('keeps an unrelated MCP disabled and preserves its normal state file', async () => {
      const f = await fixture('negative');
      const path = join(f.profile, 'mcp.json');
      const config = JSON.parse(await readFile(path, 'utf8'));
      config.mcpServers.other = {
        url: f.options.input.env.CURSOR_API_ENDPOINT + '/disabled-other',
      };
      await writeFile(path, JSON.stringify(config));
      await execa(executable!, ['mcp', 'disable', 'other'], {
        cwd: f.work,
        env: f.options.input.env,
        timeout: 10000,
      });
      const projects = join(f.profile, 'projects');
      const directories = await readdir(projects);
      const disabled = join(projects, directories[0]!, 'mcp-disabled.json');
      const original = await readFile(disabled, 'utf8');
      const baseline = await new CursorHarness({
        executable: executable!,
        extraArgs: ['--approve-mcps'],
      }).run(f.options.input);
      expect(baseline.exitCode, baseline.stderr).toBe(0);
      expect(f.disabledContacts()).toBe(0);
      const originals = f.originals();
      await runCursorWithMcp(f.options);
      expect(f.disabledContacts()).toBe(0);
      expect(f.originals()).toBe(originals);
      expect(await readFile(disabled, 'utf8')).toBe(original);
    }, 30000);

    it('rejects a negative result when only preflight discovery succeeded', async () => {
      const f = await fixture('negative');
      f.failTaskDiscovery();
      await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
        category: 'not_ready',
        message: expect.stringContaining('task process did not discover'),
      });
      expect(f.requests()).toBe(1);
      expect(f.controller.discoveryCount('linear')).toBe(1);
      expect(f.originals()).toBe(0);
    }, 30000);

    it('cancels an active task and restores workspace configuration', async () => {
      const f = await fixture('hang');
      const original = await readFile(f.paths[0]!, 'utf8');
      const abort = new AbortController();
      const pending = runCursorWithMcp({
        ...f.options,
        input: {...f.options.input, signal: abort.signal},
      });
      const stopped = expect(pending).rejects.toMatchObject({
        category: 'execution_failed',
        message: expect.stringContaining('cancelled'),
      });
      await vi.waitFor(() => expect(f.requests()).toBe(1), {timeout: 10000});
      abort.abort();
      await stopped;
      expect(await readFile(f.paths[0]!, 'utf8')).toBe(original);
      expect(f.originals()).toBe(0);
    }, 30000);

    it('preserves model authentication at the original file location', async () => {
      const f = await fixture();
      await writeFile(
        join(f.profile, 'auth.json'),
        JSON.stringify({accessToken: f.token, refreshToken: f.token}),
      );
      const {CURSOR_AUTH_TOKEN: _token, ...env} = f.options.input.env;
      await runCursorWithMcp({...f.options, input: {...f.options.input, env}});
      expect(f.modelHeaders).toEqual(['Bearer ' + f.token]);
      expect(
        JSON.parse(await readFile(join(f.profile, 'auth.json'), 'utf8')),
      ).toMatchObject({accessToken: f.token});
    }, 30000);

    it.each(['global', 'project'] as const)(
      'rejects a same-named %s stdio target before native startup',
      async (source) => {
        const f = await fixture('negative');
        const marker = join(f.root, 'original-started');
        await writeFile(
          source === 'global' ? join(f.profile, 'mcp.json') : f.paths[0]!,
          JSON.stringify({
            mcpServers: {
              linear: {
                command: process.execPath,
                args: [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
                ],
              },
            },
          }),
        );
        await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
          category: 'configuration_failed',
          message: expect.stringContaining('uses stdio'),
        });
        expect(f.requests()).toBe(0);
        expect(f.originals()).toBe(0);
        await expect(readFile(marker)).rejects.toMatchObject({code: 'ENOENT'});
      },
      30000,
    );

    it('returns a mock service error as failed tool evidence', async () => {
      const f = await fixture('call', true);
      const result = await runCursorWithMcp(f.options);
      expect(result.toolEvents).toMatchObject([
        {rawName: 'mcp__linear__get_issue', status: 'failure'},
      ]);
      expect(
        (
          await f.controller.finalize({
            harnessReady: true,
            harnessSucceeded: true,
          })
        ).calls,
      ).toHaveLength(1);
    }, 30000);

    it('restores configuration on callback failure', async () => {
      const f = await fixture();
      const original = await readFile(f.paths[0]!, 'utf8');
      await expect(
        runCursorWithMcp({
          ...f.options,
          input: {
            ...f.options.input,
            onToolEvent() {
              throw new Error('fixture callback failure');
            },
          },
        }),
      ).rejects.toMatchObject({
        category: 'execution_failed',
        message: expect.stringContaining('fixture callback failure'),
      });
      expect(await readFile(f.paths[0]!, 'utf8')).toBe(original);
      expect(f.originals()).toBe(0);
    }, 30000);

    it.each(['hang', 'error'] as const)(
      'bounds native %s retries by the deadline and restores configuration',
      async (mode) => {
        const f = await fixture(mode);
        const original = await readFile(f.paths[1]!, 'utf8');
        await expect(
          runCursorWithMcp({
            ...f.options,
            input: {
              ...f.options.input,
              timeoutMs: 4000,
            },
          }),
        ).rejects.toMatchObject({
          category: 'timed_out',
        });
        expect(f.requests()).toBeGreaterThan(0);
        expect(await readFile(f.paths[1]!, 'utf8')).toBe(original);
        expect(f.originals()).toBe(0);
      },
      30000,
    );

    it('disables a targeted plugin MCP while preserving the plugin skill', async () => {
      const f = await fixture('negative');
      f.useHealthyOriginal();
      const plugin = join(f.root, 'fixture-plugin');
      await mkdir(join(plugin, '.cursor-plugin'), {recursive: true});
      await writeFile(
        join(plugin, '.cursor-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          description: 'Synthetic native plugin',
        }),
      );
      await writeFile(
        join(plugin, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            linear: {
              url: f.options.input.env.CURSOR_API_ENDPOINT + '/original-mcp',
            },
          },
        }),
      );
      await mkdir(join(plugin, 'skills', 'plugin-skill'), {recursive: true});
      await writeFile(
        join(plugin, 'skills', 'plugin-skill', 'SKILL.md'),
        '---\nname: plugin-skill\ndescription: PLUGIN_SKILL_MARKER\n---\nRead fixture files.\n',
      );
      for (const path of [f.paths[0]!, join(f.profile, 'mcp.json')])
        await writeFile(path, '{"mcpServers":{}}');
      const baseline = await new CursorHarness({
        executable: executable!,
        extraArgs: ['--plugin-dir', plugin, '--approve-mcps'],
      }).run(f.options.input);
      expect(baseline.exitCode, baseline.stderr).toBe(0);
      expect(f.contexts.join('')).toContain('PLUGIN_SKILL_MARKER');
      expect(f.originals()).toBeGreaterThan(0);
      const native = f.contexts.join('').match(/plugin-[a-z-]+linear/)?.[0];
      expect(native).toBe('plugin-fixture-plugin-linear');
      const contacts = f.originals();
      const result = await runCursorWithMcp({
        ...f.options,
        extraArgs: ['--plugin-dir', plugin],
        servers: {[native!]: f.options.servers.linear},
      });
      expect(result.harnessReady).toBe(true);
      expect(
        f.originals(),
        f.contexts
          .join('')
          .match(/.{0,60}plugin.{0,100}/g)
          ?.join('\n'),
      ).toBe(contacts);
      expect(f.contexts.at(-1)).toContain('PLUGIN_SKILL_MARKER');
    }, 30000);
  },
);
