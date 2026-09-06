import {randomBytes} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type {Socket} from 'node:net';

import type {McpInputSchema} from '@dynobox/sdk';
import {
  type McpCallRecord,
  mcpJsonObjectSchema,
  type McpMockFailure,
  mcpMocksSchema,
  type McpObservation,
} from '@dynobox/sdk/ir';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_LIMITS = {
  requestBytes: 256 * 1024,
  resultBytes: 256 * 1024,
  definitionBytes: 4 * 1024 * 1024,
  logBytes: 8 * 1024 * 1024,
  calls: 1000,
  concurrency: 32,
  connections: 64,
  requestMs: 5000,
  cleanupMs: 1000,
};

type Limits = typeof DEFAULT_LIMITS;
type MutableCall = {-readonly [K in keyof McpCallRecord]: McpCallRecord[K]};
type RequestState = {call?: MutableCall; task: Promise<void>};
type ToolDefinition = ReturnType<
  typeof mcpMocksSchema.parse
>[string]['tools'][string];
type ToolResult = Extract<ToolDefinition, {response: unknown}>['response'];

export type McpMockController = {
  /** Sensitive runtime configuration; never put these URLs in report evidence. */
  readonly urls: Readonly<Record<string, string>>;
  /** Adapter confirmation must describe the actual child invocation. */
  finalize(outcome: {
    harnessReady: boolean;
    harnessSucceeded: boolean;
  }): Promise<McpObservation>;
};

/** Local fixture-only MCP transport. There is deliberately no forwarding path. */
export async function startMcpMockController(
  definitions: unknown,
  options: Partial<Limits> = {},
): Promise<McpMockController> {
  const limits = {...DEFAULT_LIMITS, ...options};
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error('Invalid MCP controller limits.');
  }
  const mocks = mcpMocksSchema.parse(definitions);
  if (byteLength(mocks) > limits.definitionBytes)
    throw new Error('MCP definition size limit exceeded.');
  const tools = Object.fromEntries(
    Object.entries(mocks).map(([name, server]) => [
      name,
      Object.keys(server.tools),
    ]),
  );
  for (const server of Object.values(mocks)) {
    const listed = Object.entries(server.tools).map(([name, tool]) => ({
      name,
      inputSchema: tool.inputSchema,
      ...(tool.description === undefined
        ? {}
        : {description: tool.description}),
    }));
    if (byteLength({tools: listed}) > limits.resultBytes)
      throw new Error('MCP tool-list size limit exceeded.');
    for (const tool of Object.values(server.tools)) {
      const responses =
        'response' in tool
          ? [tool.response]
          : [
              ...tool.responses,
              ...(typeof tool.onExhausted === 'object'
                ? [tool.onExhausted]
                : []),
            ];
      if (
        responses.some((response) => byteLength(response) > limits.resultBytes)
      )
        throw new Error('MCP response size limit exceeded.');
    }
  }

  const routes = new Map(
    Object.keys(mocks).map((name) => [
      `/${randomBytes(24).toString('hex')}`,
      name,
    ]),
  );
  const indexes = new Map<string, number>();
  const calls: MutableCall[] = [];
  const failures = new Set<McpMockFailure>();
  const initialized = new Set<string>();
  const discovered = new Set<string>();
  const active = new Set<RequestState>();
  const sockets = new Set<Socket>();
  let logBytes = 0;
  let sealed = false;
  let finalization: Promise<McpObservation> | undefined;
  let host = '';

  const listener = createServer(
    {
      headersTimeout: limits.requestMs,
      requestTimeout: limits.requestMs,
      connectionsCheckingInterval: Math.min(limits.requestMs, 1000),
    },
    (request, response) => {
      const name = routes.get(request.url ?? '');
      if (sealed || name === undefined) return reject(response, 404);
      if (
        request.headers.host !== host ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== `http://${host}`)
      )
        return reject(response, 403);
      // V1 has no server-initiated events or persistent sessions.
      if (request.method !== 'POST') return reject(response, 405);
      if (active.size >= limits.concurrency) {
        failures.add('limit_exceeded');
        return reject(response, 503);
      }
      const state: RequestState = {task: Promise.resolve()};
      active.add(state);
      state.task = handleRequest(name, request, response, state).finally(() =>
        active.delete(state),
      );
    },
  );
  listener.on('connection', (socket) => {
    if (sealed || sockets.size >= limits.connections) {
      if (!sealed) failures.add('limit_exceeded');
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(limits.requestMs, () => socket.destroy());
  });
  listener.on('clientError', (_error, socket) => {
    if (!sealed) failures.add('protocol_failed');
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      listener.off('error', reject);
      resolve();
    });
  });
  listener.on('error', () => {
    if (!sealed) failures.add('protocol_failed');
  });
  const address = listener.address();
  if (address === null || typeof address === 'string')
    throw new Error('MCP listener did not bind.');
  host = `127.0.0.1:${address.port}`;

  async function handleRequest(
    name: string,
    request: IncomingMessage,
    response: ServerResponse,
    state: RequestState,
  ): Promise<void> {
    let server: Server | undefined;
    let delivered = false;
    let listedTools = false;
    let method: string | undefined;
    const finished = new Promise<void>((resolve) => {
      response.once('finish', () => {
        delivered = true;
        resolve();
      });
      response.once('close', resolve);
    });
    const timer = setTimeout(() => {
      if (!sealed) failures.add('protocol_failed');
      request.destroy();
      response.destroy();
    }, limits.requestMs);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > limits.requestBytes) {
          if (!sealed) failures.add('limit_exceeded');
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (sealed) return reject(response, 404);
      const message = JSONRPCMessageSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (!('method' in message))
        throw new Error('Unexpected client response.');
      method = message.method;
      if (method === 'tools/call') CallToolRequestSchema.parse(message);
      const definition = mocks[name]!;
      server = new Server(
        {name, version: '0.1.0'},
        {
          capabilities: {tools: {}},
          ...(definition.instructions === undefined
            ? {}
            : {instructions: definition.instructions}),
        },
      );
      server.onerror = () => {
        if (!sealed) failures.add('protocol_failed');
      };
      server.setRequestHandler(ListToolsRequestSchema, () => {
        listedTools = true;
        return {
          tools: Object.entries(definition.tools).map(([name, tool]) => ({
            name,
            inputSchema: structuredClone(tool.inputSchema) as McpInputSchema,
            ...(tool.description === undefined
              ? {}
              : {description: tool.description}),
          })),
        };
      });
      server.setRequestHandler(CallToolRequestSchema, (call) => {
        if (sealed)
          throw new McpError(ErrorCode.InternalError, 'MCP mock is closed.');
        const input = mcpJsonObjectSchema.parse(call.params.arguments ?? {});
        const record: MutableCall = {
          sequence: calls.length + 1,
          server: name,
          tool: call.params.name,
          input,
          category: 'success',
        };
        const size = byteLength(record);
        if (calls.length >= limits.calls || logBytes + size > limits.logBytes) {
          failures.add('limit_exceeded');
          throw new McpError(
            ErrorCode.InternalError,
            'MCP call log limit exceeded.',
          );
        }
        calls.push(record);
        state.call = record;
        logBytes += size;
        if (!Object.hasOwn(definition.tools, call.params.name)) {
          record.category = 'unknown_tool';
          failures.add('unknown_tool');
          throw new McpError(ErrorCode.InvalidParams, 'Unknown mock tool.');
        }
        const tool = definition.tools[call.params.name]!;
        let result: ToolResult;
        if ('response' in tool) result = tool.response;
        else {
          const key = JSON.stringify([name, call.params.name]);
          const index = indexes.get(key) ?? 0;
          indexes.set(key, index + 1);
          if (index < tool.responses.length) result = tool.responses[index]!;
          else if (tool.onExhausted === 'repeat-last')
            result = tool.responses.at(-1)!;
          else if (typeof tool.onExhausted === 'object')
            result = tool.onExhausted;
          else {
            record.category = 'exhausted';
            failures.add('exhausted');
            throw new McpError(
              ErrorCode.InternalError,
              'MCP mock responses exhausted.',
            );
          }
        }
        record.category = result.isError ? 'tool_error' : 'success';
        return structuredClone(result);
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      // SDK transport accessors include undefined; its Transport interface does
      // not, which conflicts with exactOptionalPropertyTypes in this project.
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, message);
      await finished;
      if (!sealed && response.statusCode < 400 && delivered) {
        if (method === 'initialize' && server.getClientVersion() !== undefined)
          initialized.add(name);
        if (listedTools) discovered.add(name);
      } else if (!sealed) failures.add('protocol_failed');
    } catch {
      if (!sealed) failures.add('protocol_failed');
      if (!response.headersSent && !response.destroyed) reject(response, 400);
      else response.destroy();
    } finally {
      clearTimeout(timer);
      if (!delivered && state.call !== undefined && !sealed) {
        state.call.category = 'transport_failed';
        failures.add('protocol_failed');
      }
      try {
        if (server !== undefined)
          await bounded(server.close(), limits.cleanupMs);
      } catch {
        failures.add('cleanup_failed');
      }
    }
  }

  async function finalize(outcome: {
    harnessReady: boolean;
    harnessSucceeded: boolean;
  }): Promise<McpObservation> {
    sealed = true;
    const pending = [...active];
    if (pending.length > 0) {
      failures.add('pending_calls');
      for (const state of pending)
        if (state.call !== undefined) state.call.category = 'transport_failed';
    }
    const ready =
      outcome.harnessReady &&
      outcome.harnessSucceeded &&
      Object.keys(mocks).every(
        (name) => initialized.has(name) && discovered.has(name),
      );
    if (!ready) failures.add('not_ready');
    const closed = new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    for (const socket of sockets) socket.destroy();
    try {
      await bounded(
        Promise.all([closed, ...pending.map((state) => state.task)]),
        limits.cleanupMs,
      );
    } catch {
      failures.add('cleanup_failed');
    }
    return deepFreeze({
      finalized: true,
      ready,
      failures: [...failures],
      tools,
      calls: structuredClone(calls),
    });
  }

  return {
    urls: Object.freeze(
      Object.fromEntries(
        [...routes].map(([path, name]) => [name, `http://${host}${path}`]),
      ),
    ),
    finalize(outcome) {
      finalization ??= finalize(outcome);
      return finalization;
    },
  };
}

function reject(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain',
    Connection: 'close',
  });
  response.end('MCP request rejected.');
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function bounded<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('MCP cleanup timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
