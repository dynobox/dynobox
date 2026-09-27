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

const REQUEST_TIMEOUT_MS = 5000;
const CLEANUP_TIMEOUT_MS = 1000;

type MutableCall = {-readonly [K in keyof McpCallRecord]: McpCallRecord[K]};
type RequestState = {call?: MutableCall; task: Promise<void>};
type ToolDefinition = ReturnType<
  typeof mcpMocksSchema.parse
>[string]['tools'][string];
type ToolResult = Extract<ToolDefinition, {response: unknown}>['response'];

export type McpMockController = {
  readonly urls: Readonly<Record<string, string>>;
  /** Seal the call log. Adapter confirmation must describe the actual child invocation. */
  finalize(outcome: {
    harnessReady: boolean;
    harnessSucceeded: boolean;
  }): Promise<McpObservation>;
};

/** Local fixture-only MCP transport. There is deliberately no forwarding path. */
export async function startMcpMockController(
  definitions: unknown,
): Promise<McpMockController> {
  const mocks = mcpMocksSchema.parse(definitions);
  const tools = Object.fromEntries(
    Object.entries(mocks).map(([name, server]) => [
      name,
      Object.keys(server.tools),
    ]),
  );
  const routes = new Map(
    Object.keys(mocks).map((name) => [`/${encodeURIComponent(name)}`, name]),
  );
  const indexes = new Map<string, number>();
  const calls: MutableCall[] = [];
  const failures = new Set<McpMockFailure>();
  const initialized = new Set<string>();
  const discovered = new Set<string>();
  const active = new Set<RequestState>();
  const sockets = new Set<Socket>();
  let sealed = false;
  let finalization: Promise<McpObservation> | undefined;

  const listener = createServer((request, response) => {
    const name = routes.get(request.url ?? '');
    if (sealed || name === undefined) return reject(response, 404);
    // V1 has no server-initiated events or persistent sessions.
    if (request.method !== 'POST') return reject(response, 405);
    const state: RequestState = {task: Promise.resolve()};
    active.add(state);
    state.task = handleRequest(name, request, response, state).finally(() =>
      active.delete(state),
    );
  });
  listener.on('connection', (socket) => {
    if (sealed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
  const host = `127.0.0.1:${address.port}`;

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
    }, REQUEST_TIMEOUT_MS);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (sealed) return reject(response, 404);
      const message = JSONRPCMessageSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (!('method' in message))
        throw new Error('Unexpected client response.');
      method = message.method;
      // Modern clients probe before falling back to the legacy handshake. The
      // pinned SDK rejects their newer protocol header before method dispatch.
      // Decline only this unsupported discovery RPC; it establishes no readiness
      // and does not claim support for the modern protocol or bypass tool checks.
      if (method === 'server/discover' && 'id' in message) {
        response.writeHead(404, {'Content-Type': 'application/json'});
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: 'Method not found',
            },
          }),
        );
        await finished;
        if (!delivered && !sealed) failures.add('protocol_failed');
        return;
      }
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
        const parsed = mcpJsonObjectSchema.safeParse(
          call.params.arguments ?? {},
        );
        if (!parsed.success) {
          // The model did call a tool, so a negative assertion must not pass.
          failures.add('protocol_failed');
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid tool arguments.',
          );
        }
        const input = parsed.data;
        const record: MutableCall = {
          sequence: calls.length + 1,
          server: name,
          tool: call.params.name,
          input,
          category: 'success',
        };
        calls.push(record);
        state.call = record;
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
          await bounded(server.close(), CLEANUP_TIMEOUT_MS);
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
    const discoveredAll = Object.keys(mocks).every(
      (name) => initialized.has(name) && discovered.has(name),
    );
    const ready =
      outcome.harnessReady && outcome.harnessSucceeded && discoveredAll;
    // A harness that failed after discovery reports its own failure; calling
    // it not_ready too would point at startup.
    if (!discoveredAll || (outcome.harnessSucceeded && !outcome.harnessReady))
      failures.add('not_ready');
    const closed = new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    for (const socket of sockets) socket.destroy();
    try {
      await bounded(
        Promise.all([closed, ...pending.map((state) => state.task)]),
        CLEANUP_TIMEOUT_MS,
      );
    } catch {
      failures.add('cleanup_failed');
    }
    return {
      finalized: true,
      ready,
      failures: [...failures],
      tools,
      calls: structuredClone(calls),
    };
  }

  return {
    urls: Object.fromEntries(
      [...routes].map(([path, name]) => [name, `http://${host}${path}`]),
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
