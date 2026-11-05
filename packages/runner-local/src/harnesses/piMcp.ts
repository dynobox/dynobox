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
const VALUE_FLAGS = new Set([
  '--thinking',
  '--tools',
  '-t',
  '--exclude-tools',
  '-xt',
  '--provider',
  '--model',
  '--api-key',
  '--system-prompt',
  '--append-system-prompt',
  '--skill',
  '--theme',
  '--use-theme',
]);
const SWITCH_FLAGS = new Set([
  '--no-tools',
  '-nt',
  '--no-builtin-tools',
  '-nbt',
  '--no-skills',
  '-ns',
  '--no-prompt-templates',
  '-np',
  '--no-themes',
  '--no-context-files',
  '-nc',
  '--verbose',
  '--offline',
  '--no-extensions',
  '-ne',
]);
const READY_MARKER = 'DYNOBOX_MCP_READY';
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
  const extraArgs = options.extraArgs ?? [];
  for (let index = 0; index < extraArgs.length; index++) {
    const flag = extraArgs[index]!;
    if (SWITCH_FLAGS.has(flag)) continue;
    if (VALUE_FLAGS.has(flag)) {
      const value = extraArgs[++index];
      if (
        value !== undefined &&
        !value.startsWith('-') &&
        !value.startsWith('@')
      )
        continue;
    }
    throw new McpHarnessError(
      'configuration_failed',
      `Pi extra argument ${flag} is unsupported or missing a value for MCP mocking.`,
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
    ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
  };
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...processOptions,
    stdin: 'ignore',
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
        ['--no-extensions', '-e', bridge, ...extraArgs],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, input: input.prompt, timeout: remaining()},
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
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stream.write(chunk));
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
    if (!result.stderr.split(/\r?\n/).includes(READY_MARKER))
      throw new McpHarnessError(
        'not_ready',
        'Pi did not confirm MCP bridge readiness.',
      );
    const parsed = parsePiJson(result.stdout);
    if (parsed.terminalFailure || result.stdout.trim() === '')
      throw new McpHarnessError(
        'execution_failed',
        parsed.errorMessage ?? 'Pi finished without execution output.',
      );
    return {
      harnessReady: true,
      version,
      output,
      toolEvents: parsed.toolEvents,
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
import {writeSync} from 'node:fs';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const servers = ${JSON.stringify(servers)};
const tools = ${JSON.stringify(tools)};
const notReady = (reason) => {
  writeSync(2, ${JSON.stringify(NOT_READY_MARKER)} + ' ' + reason + '\\n');
  process.exit(1);
};
export default async function(pi) {
  const clients = [];
  const instructions = [];
  for (const [server, connection] of Object.entries(servers)) {
    const client = new Client({name: 'dynobox-pi', version: '1.0.0'});
    clients.push(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url)));
    } catch {
      notReady('Could not connect to MCP mock server "' + server + '".');
    }
    try {
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
            const content = [...result.content];
            // Pi sends content to the model; details are metadata only.
            if (result.structuredContent !== undefined)
              content.push({type: 'text', text: JSON.stringify(result.structuredContent)});
            if (result.isError) throw new Error(content
              .filter((block) => block.type === 'text')
              .map((block) => block.text).join('\\n') || 'MCP tool failed.');
            return {content, details: result.structuredContent || {}};
          }
        });
      }
    } catch (error) {
      notReady('Could not initialize MCP mock server "' + server + '": ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (instructions.length) pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\\n\\n' + instructions.join('\\n\\n')
  }));
  pi.on('session_start', () => {
    const active = pi.getActiveTools();
    const missing = tools.find((name) => !active.includes(name));
    if (missing) notReady('Pi did not activate MCP mock tool "' + missing + '".');
    writeSync(2, ${JSON.stringify(READY_MARKER)} + '\\n');
  });
  pi.on('session_shutdown', () => Promise.all(clients.map((client) => client.close())));
}
`;
}
