import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';

import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
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
  const tools = piToolNames(servers);
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
    await writeFile(bridge, piBridgeSource(servers, tools));
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
    for (const event of parsed.toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        metadata: {mcpHarnessVersion: version},
      },
    };
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/**
 * Pi registers each mock as `mcp__<server>__<tool>`, and Pi tool names must
 * match ^[a-zA-Z0-9_-]{1,64}$. Reject names Pi cannot register rather than
 * renaming them, so the model sees the same tool names on every harness.
 */
export function piToolNames(servers: McpServerConnections): string[] {
  const names = new Set<string>();
  for (const [server, {tools}] of Object.entries(servers))
    for (const tool of tools) {
      const name = `mcp__${server}__${tool}`;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
        throw new McpHarnessError(
          'configuration_failed',
          `Pi cannot register MCP mock tool "${server}/${tool}": "${name}" must be at most 64 letters, digits, "_" or "-".`,
        );
      if (names.has(name))
        throw new McpHarnessError(
          'configuration_failed',
          `Pi cannot register MCP mock tool "${server}/${tool}": "${name}" is already used by another mock.`,
        );
      names.add(name);
    }
  return [...names];
}

// Loaded only by Pi. Transport dependencies resolve from runner-local,
// including when the runner is bundled into dist/index.js.
function piBridgeSource(
  servers: McpServerConnections,
  tools: readonly string[],
): string {
  return `
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const servers = ${JSON.stringify(servers)};
const tools = ${JSON.stringify(tools)};
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
      const name = 'mcp__' + server + '__' + tool.name;
      if (!tools.includes(name)) continue;
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
    const missing = tools.find((name) => !active.includes(name));
    if (missing) notReady('Pi did not activate MCP mock tool "' + missing + '".');
  });
  pi.on('session_shutdown', () => Promise.all(clients.map((client) => client.close())));
}
`;
}
