import {request as httpRequest} from 'node:http';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {type McpMockController, startMcpMockController} from './controller.js';

const result = (text: string) => ({content: [{type: 'text' as const, text}]});
const schema = {
  type: 'object' as const,
  properties: {id: {type: 'string'}},
  required: ['id'],
};
const definitions = {
  linear: {
    instructions: 'Use the mock.',
    tools: {save: {inputSchema: schema, response: result('SECRET_RESPONSE')}},
  },
};
const controllers: McpMockController[] = [];
const success = {harnessReady: true, harnessSucceeded: true};
let requestId = 0;

async function start(
  value: unknown = definitions,
  options: Parameters<typeof startMcpMockController>[1] = {},
) {
  const controller = await startMcpMockController(value, options);
  controllers.push(controller);
  return controller;
}

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: ++requestId, method, params}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: {
      protocolVersion: string;
      tools: {inputSchema: unknown}[];
      content: {text: string}[];
      isError?: boolean;
    };
    error?: unknown;
  };
}

async function discover(url: string, version = '2025-03-26') {
  const initialized = await rpc(url, 'initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: {name: 'test', version: '1'},
  });
  expect(initialized.result.protocolVersion).toBe(version);
  return rpc(url, 'tools/list');
}

afterEach(async () => {
  await Promise.all(
    controllers
      .splice(0)
      .map((controller) =>
        controller.finalize({harnessReady: false, harnessSucceeded: false}),
      ),
  );
});

describe('MCP controller', () => {
  it('works through the official MCP client and records schema-violating arguments unchanged', async () => {
    const controller = await start();
    const client = new Client({name: 'test-client', version: '1'});
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(controller.urls.linear!),
        ) as Transport,
      );
      expect((await client.listTools()).tools[0]!.inputSchema).toEqual(schema);
      expect(
        await client.callTool({
          name: 'save',
          arguments: {id: 123, secret: 'SECRET_INPUT'},
        }),
      ).toEqual(result('SECRET_RESPONSE'));
    } finally {
      await client.close();
    }
    const observation = await controller.finalize(success);
    expect(observation.failures).toEqual([]);
    expect(observation.ready).toBe(true);
    expect(observation.calls).toEqual([
      {
        sequence: 1,
        server: 'linear',
        tool: 'save',
        input: {id: 123, secret: 'SECRET_INPUT'},
        category: 'success',
      },
    ]);
    expect(JSON.stringify(observation)).not.toContain('SECRET_RESPONSE');
  });

  it.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])(
    'negotiates protocol %s',
    async (version) => {
      const controller = await start();
      expect(
        (await discover(controller.urls.linear!, version)).result.tools[0]!
          .inputSchema,
      ).toEqual(schema);
      expect((await controller.finalize(success)).calls).toEqual([]);
    },
  );

  it('reserves concurrent responses in call-log order, including arguments that violate the schema', async () => {
    const controller = await start({
      linear: {
        tools: {
          save: {
            inputSchema: schema,
            responses: Array.from({length: 8}, (_, index) =>
              result(String(index)),
            ),
          },
        },
      },
    });
    const url = controller.urls.linear!;
    await discover(url);
    const receipts = await Promise.all(
      Array.from({length: 8}, (_, index) =>
        rpc(url, 'tools/call', {name: 'save', arguments: {id: index}}),
      ),
    );
    const observation = await controller.finalize(success);
    expect(observation.failures).toEqual([]);
    for (const call of observation.calls) {
      expect(receipts[call.input.id as number]!.result.content[0]!.text).toBe(
        String(call.sequence - 1),
      );
    }
  });

  it.each(['error', 'repeat-last', result('fallback')])(
    'handles sequence exhaustion %#',
    async (onExhausted) => {
      const controller = await start({
        linear: {
          tools: {
            save: {
              inputSchema: schema,
              responses: [{...result('first'), isError: true}],
              onExhausted,
            },
          },
        },
      });
      const url = controller.urls.linear!;
      await discover(url);
      expect(
        (await rpc(url, 'tools/call', {name: 'save'})).result.isError,
      ).toBe(true);
      const second = await rpc(url, 'tools/call', {name: 'save'});
      const observation = await controller.finalize(success);
      expect(observation.calls[0]!.category).toBe('tool_error');
      if (onExhausted === 'error') {
        expect(second.error).toBeDefined();
        expect(observation.failures).toContain('exhausted');
        expect(observation.calls[1]!.category).toBe('exhausted');
      } else {
        expect(second.result.content[0]!.text).toBe(
          onExhausted === 'repeat-last' ? 'first' : 'fallback',
        );
        expect(observation.failures).toEqual([]);
      }
    },
  );

  it('records unknown tools as failed attempts', async () => {
    const controller = await start();
    await discover(controller.urls.linear!);
    expect(
      (
        await rpc(controller.urls.linear!, 'tools/call', {
          name: 'unknown',
          arguments: {id: 'secret'},
        })
      ).error,
    ).toBeDefined();
    const observation = await controller.finalize(success);
    expect(observation.failures).toContain('unknown_tool');
    expect(observation.calls[0]!.category).toBe('unknown_tool');
  });

  it('requires discovery of every mock and adapter confirmation for a negative-only run', async () => {
    const controller = await start({
      linear: definitions.linear,
      other: definitions.linear,
    });
    await discover(controller.urls.linear!);
    expect((await controller.finalize(success)).failures).toContain(
      'not_ready',
    );
    const unconfirmed = await start();
    await discover(unconfirmed.urls.linear!);
    expect(
      (await unconfirmed.finalize({...success, harnessReady: false})).ready,
    ).toBe(false);
    const failed = await start();
    await discover(failed.urls.linear!);
    expect(
      (await failed.finalize({...success, harnessSucceeded: false})).ready,
    ).toBe(false);
  });

  it('does not treat an initialization error response as readiness', async () => {
    const controller = await start();
    expect(
      (await rpc(controller.urls.linear!, 'initialize', {})).error,
    ).toBeDefined();
    await rpc(controller.urls.linear!, 'tools/list');
    expect((await controller.finalize(success)).ready).toBe(false);
  });

  it.each(['reject', 'timeout'])(
    'records bounded cleanup failure (%s) without exception text',
    async (mode) => {
      const controller = await start(definitions, {cleanupMs: 20});
      const close = Server.prototype.close;
      const spy = vi
        .spyOn(Server.prototype, 'close')
        .mockImplementationOnce(async function (this: Server) {
          await close.call(this);
          if (mode === 'reject') throw new Error('SECRET_CLEANUP');
          await new Promise<void>(() => {});
        });
      try {
        await discover(controller.urls.linear!);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const observation = await controller.finalize(success);
        expect(observation.failures).toContain('cleanup_failed');
        expect(JSON.stringify(observation)).not.toContain('SECRET_CLEANUP');
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('isolates jobs and copies definitions before launch', async () => {
    const authored = {
      linear: {
        tools: {
          save: {
            inputSchema: schema,
            responses: [result('first'), result('second')],
          },
        },
      },
    };
    const first = await start(authored);
    const second = await start(authored);
    authored.linear.tools.save.responses[0]!.content[0]!.text = 'mutated';
    expect(first.urls.linear).not.toBe(second.urls.linear);
    for (const controller of [first, second]) {
      await discover(controller.urls.linear!);
      expect(
        (await rpc(controller.urls.linear!, 'tools/call', {name: 'save'}))
          .result.content[0]!.text,
      ).toBe('first');
      expect((await controller.finalize(success)).calls).toHaveLength(1);
    }
  });

  it('rejects wrong tokens, Hosts, and Origins', async () => {
    const controller = await start();
    const url = controller.urls.linear!;
    expect((await fetch(new URL('/wrong', url))).status).toBe(404);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        url,
        {method: 'POST', headers: {Host: 'attacker.example'}},
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: {Origin: 'https://attacker.example'},
        })
      ).status,
    ).toBe(403);
  });

  it.each([{calls: 1}, {logBytes: 1}])(
    'fails the job on retained-log overflow %#',
    async (limits) => {
      const controller = await start(definitions, limits);
      await discover(controller.urls.linear!);
      await rpc(controller.urls.linear!, 'tools/call', {name: 'save'});
      await rpc(controller.urls.linear!, 'tools/call', {name: 'save'});
      expect((await controller.finalize(success)).failures).toContain(
        'limit_exceeded',
      );
    },
  );

  it('bounds configured result sizes and rejects malformed protocol messages', async () => {
    await expect(start(definitions, {resultBytes: 1})).rejects.toThrow(
      'size limit',
    );
    const controller = await start();
    const response = await fetch(controller.urls.linear!, {
      method: 'POST',
      body: 'not JSON',
    });
    expect(response.status).toBe(400);
    expect((await controller.finalize(success)).failures).toContain(
      'protocol_failed',
    );
  });

  it('fails oversized request bodies without retaining their contents', async () => {
    const controller = await start(definitions, {requestBytes: 16});
    await expect(
      fetch(controller.urls.linear!, {
        method: 'POST',
        body: 'SECRET'.repeat(100),
      }),
    ).rejects.toThrow();
    const observation = await controller.finalize(success);
    expect(observation.failures).toContain('limit_exceeded');
    expect(observation.calls).toEqual([]);
  });

  it('bounds concurrent slow requests and their lifetime', async () => {
    const controller = await start(definitions, {
      concurrency: 1,
      requestMs: 100,
    });
    const request = httpRequest(controller.urls.linear!, {
      method: 'POST',
      headers: {'Content-Length': 100},
    });
    const closed = new Promise<void>((resolve) =>
      request.on('error', () => resolve()),
    );
    request.write('{');
    await new Promise<void>((resolve) =>
      request.once('socket', (socket) =>
        socket.once('connect', () => setTimeout(resolve, 10)),
      ),
    );
    expect(
      (await fetch(controller.urls.linear!, {method: 'POST', body: '{}'}))
        .status,
    ).toBe(503);
    await closed;
    const observation = await controller.finalize(success);
    expect(observation.failures).toContain('limit_exceeded');
    expect(observation.failures).toContain('protocol_failed');
  });

  it('fails pending requests, revokes routes, and seals evidence on idempotent finalization', async () => {
    const controller = await start();
    await discover(controller.urls.linear!);
    await rpc(controller.urls.linear!, 'tools/call', {
      name: 'save',
      arguments: {nested: {id: 1}},
    });
    const request = httpRequest(controller.urls.linear!, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': 100},
    });
    request.on('error', () => {});
    request.write('{');
    await new Promise<void>((resolve) =>
      request.once('socket', (socket) =>
        socket.once('connect', () => setTimeout(resolve, 10)),
      ),
    );
    const observation = await controller.finalize(success);
    expect(observation.failures).toContain('pending_calls');
    expect(
      await controller.finalize({harnessReady: false, harnessSucceeded: false}),
    ).toBe(observation);
    expect(Object.isFrozen(observation.calls[0]!.input.nested)).toBe(true);
    await expect(fetch(controller.urls.linear!)).rejects.toThrow();
    expect(observation.calls).toHaveLength(1);
    request.destroy();
  });
});
