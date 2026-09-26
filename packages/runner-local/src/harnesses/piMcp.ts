import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';

import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {createToolEvent} from './parsing.js';
import {buildPiArgs, parsePiJson} from './pi.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';
import {isAtLeastVersion, parseVersion} from './version.js';

// Oldest release whose `--no-extensions` isolation was verified natively.
const MIN_VERSION = '0.84.2';
// Extensions can register their own MCP servers beside the mocks.
const EXTENSION_FLAGS = new Set(['-e', '--extension', '--extensions']);
const NOT_READY_MARKER = 'DYNOBOX_MCP_NOT_READY:';

export async function runPiWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  for (const arg of options.extraArgs ?? []) {
    const flag = arg.split('=')[0]!;
    if (EXTENSION_FLAGS.has(flag))
      throw new McpHarnessError(
        'configuration_failed',
        `Pi extra argument ${flag} conflicts with MCP mocking.`,
      );
  }
  const aliases = piToolAliases(servers);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    PI_OFFLINE: '1',
  };
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd: input.workDir,
    env,
    extendEnv: false,
    reject: false as const,
    stdin: 'ignore' as const,
    forceKillAfterDelay: 1000,
    ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
  };
  const probe = await execa(executable, ['--version'], {
    ...processOptions,
    timeout: Math.min(5000, remaining()),
  });
  remaining();
  const version = parseVersion(probe.stdout);
  if (probe.failed || !isAtLeastVersion(version, MIN_VERSION))
    throw new McpHarnessError(
      'unsupported_version',
      `Pi MCP mocking requires ${MIN_VERSION} or newer (found ${version ?? 'unknown'}).`,
    );

  const directory = await mkdtemp(join(tmpdir(), 'dynobox-pi-mcp-'));
  try {
    const bridge = join(directory, 'bridge.mjs');
    await writeFile(bridge, piBridgeSource(servers, aliases));
    const result = await execa(
      executable,
      buildPiArgs(
        input.prompt,
        [...(options.extraArgs ?? []), '--no-extensions', '-e', bridge],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, timeout: remaining()},
    );
    remaining();
    const notReady = result.stderr
      .split('\n')
      .find((line) => line.startsWith(NOT_READY_MARKER));
    if (notReady !== undefined)
      throw new McpHarnessError(
        'not_ready',
        notReady.slice(NOT_READY_MARKER.length).trim(),
      );
    if (result.failed)
      throw new McpHarnessError(
        'execution_failed',
        `Pi exited with code ${result.exitCode ?? 'unknown'}.`,
      );
    const parsed = parsePiJson(result.stdout);
    if (parsed.terminalFailure || !parsed.finalMessage)
      throw new McpHarnessError(
        'execution_failed',
        parsed.errorMessage ?? 'Pi finished without a final message.',
      );
    const logical = new Map(
      Object.entries(aliases).map(([name, alias]) => [alias, name]),
    );
    const toolEvents = parsed.toolEvents.map((event) => {
      const name = logical.get(event.rawName);
      return name === undefined
        ? event
        : createToolEvent(name, event.input, event.status, event.message);
    });
    for (const event of toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        metadata: {mcpHarnessVersion: version, mcpRunToolEvents: toolEvents},
      },
    };
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/**
 * Pi tool names must match ^[a-zA-Z0-9_-]{1,64}$. Keep the portable
 * `mcp__server__tool` name when it fits and fall back to a stable hash.
 * Keys are logical names; values are the names registered with Pi.
 */
export function piToolAliases(
  servers: McpServerConnections,
): Record<string, string> {
  const aliases: Record<string, string> = {};
  const used = new Set<string>();
  for (const [server, {tools}] of Object.entries(servers))
    for (const tool of tools) {
      const logical = `mcp__${server}__${tool}`;
      let alias = logical;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || used.has(alias))
        alias = `mcp__${createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 24)}`;
      used.add(alias);
      aliases[logical] = alias;
    }
  return aliases;
}

// Loaded only by Pi. Transport dependencies resolve from runner-local,
// including when the runner is bundled into dist/index.js.
function piBridgeSource(
  servers: McpServerConnections,
  aliases: Record<string, string>,
): string {
  return `
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const servers = ${JSON.stringify(servers)};
const aliases = ${JSON.stringify(aliases)};
const notReady = (reason) => {
  console.error(${JSON.stringify(NOT_READY_MARKER)} + ' ' + reason);
  process.exit(1);
};
export default async function(pi) {
  const clients = [];
  for (const [server, connection] of Object.entries(servers)) {
    const client = new Client({name: 'dynobox-pi', version: '1.0.0'});
    client.onerror = () => notReady('Lost connection to MCP mock server "' + server + '".');
    clients.push(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url)));
    } catch {
      notReady('Could not connect to MCP mock server "' + server + '".');
    }
    const listing = await client.listTools();
    for (const tool of listing.tools) {
      const name = aliases['mcp__' + server + '__' + tool.name];
      if (name === undefined) continue;
      pi.registerTool({name, label: server + '/' + tool.name,
        description: tool.description || server + '/' + tool.name,
        parameters: tool.inputSchema,
        async execute(id, args, signal) {
          const result = await client.callTool({name: tool.name, arguments: args}, undefined, {signal});
          if (result.isError) throw new Error(JSON.stringify(result.content));
          return {content: result.content, details: result.structuredContent || {}};
        }
      });
    }
  }
  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    const missing = Object.entries(aliases).find(([, name]) => !active.includes(name));
    if (missing) notReady('Pi did not activate MCP mock tool "' + missing[0] + '".');
  });
  pi.on('session_shutdown', () => Promise.all(clients.map((client) => client.close())));
}
`;
}
