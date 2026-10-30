import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {buildPiArgs, parsePiJson, parsePiJsonLine} from './pi.js';
import {ToolEventLineStream} from './runStreamingHarness.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

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
}): Promise<McpHarnessRun> {
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
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...processOptions,
    timeout: Math.min(5000, remaining()),
  });
  let version: string;
  try {
    remaining();
    version = requireMcpVersion('Pi', MIN_VERSION, probe);
  } catch (error) {
    if (error instanceof McpHarnessError)
      throw new McpHarnessError(error.category, error.message, {
        exitCode: probe.exitCode ?? 1,
        stdout: probe.stdout,
        stderr: probe.stderr,
        durationMs: probe.durationMs,
      });
    throw error;
  }

  const directory = await mkdtemp(join(tmpdir(), 'dynobox-pi-mcp-'));
  let output: HarnessRunOutput | undefined;
  try {
    const bridge = join(directory, 'bridge.mjs');
    await writeFile(bridge, piBridgeSource(servers, tools));
    const toolInputs = new Map<string, unknown>();
    const child = startOwnedProcess(
      executable,
      buildPiArgs(
        input.prompt,
        [...(options.extraArgs ?? []), '--no-extensions', '-e', bridge],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, timeout: remaining()},
    );
    let callbackFailure: McpHarnessError | undefined;
    const stream = new ToolEventLineStream({
      parseLine: (line, lineNumber) =>
        parsePiJsonLine(line, lineNumber, toolInputs),
      onToolEvent: (event) => {
        if (callbackFailure !== undefined) return;
        try {
          input.onToolEvent?.(event);
        } catch (error) {
          callbackFailure = new McpHarnessError(
            'execution_failed',
            `Pi tool-event callback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          child.stop();
        }
      },
    });
    child.stdout?.on('data', (chunk: Buffer | string) =>
      stream.write(chunk.toString()),
    );
    const result = await child;
    output = {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
    stream.flush();
    if (callbackFailure !== undefined) throw callbackFailure;
    remaining();
    if (result.timedOut)
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    const notReady = result.stderr
      .split('\n')
      .find((line) => line.startsWith(NOT_READY_MARKER));
    if (notReady !== undefined)
      throw new McpHarnessError(
        'not_ready',
        notReady.slice(NOT_READY_MARKER.length).trim(),
      );
    if (result.failed || output.exitCode !== 0)
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
    return {
      harnessReady: true,
      version,
      output,
    };
  } catch (error) {
    if (output !== undefined)
      throw new McpHarnessError(
        error instanceof McpHarnessError ? error.category : 'execution_failed',
        error instanceof Error ? error.message : String(error),
        output,
      );
    throw error;
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/** Pi registers each mock under the `mcp__<server>__<tool>` name. */
export function piToolNames(servers: McpServerConnections): string[] {
  return Object.entries(servers).flatMap(([server, {tools}]) =>
    tools.map((tool) => `mcp__${server}__${tool}`),
  );
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
  const instructions = [];
  for (const [server, connection] of Object.entries(servers)) {
    const client = new Client({name: 'dynobox-pi', version: '1.0.0'});
    client.onerror = () => notReady('Lost connection to MCP mock server "' + server + '".');
    clients.push(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url)));
    } catch {
      notReady('Could not connect to MCP mock server "' + server + '".');
    }
    const guidance = client.getInstructions();
    if (guidance) instructions.push('MCP server ' + server + ':\\n' + guidance);
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
  if (instructions.length) pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\\n\\n' + instructions.join('\\n\\n')
  }));
  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    const missing = tools.find((name) => !active.includes(name));
    if (missing) notReady('Pi did not activate MCP mock tool "' + missing + '".');
  });
  pi.on('session_shutdown', () => Promise.all(clients.map((client) => client.close())));
}
`;
}
