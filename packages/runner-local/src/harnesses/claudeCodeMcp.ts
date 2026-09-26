import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';

import {
  buildClaudeCodeArgs,
  parseClaudeCodeStreamJsonLine,
} from './claudeCode.js';
import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';
import {isAtLeastVersion, parseVersion} from './version.js';

// Oldest release whose `--strict-mcp-config` isolation was verified natively.
const MIN_VERSION = '2.1.263';
// Flags that would load MCP servers beyond the generated mock config.
const MCP_CONFIG_FLAGS = new Set(['--mcp-config', '--strict-mcp-config']);
const ALLOWED_TOOLS_FLAGS = new Set(['--allowedTools', '--allowed-tools']);

export type ClaudeCodeMcpOptions = {
  /** Resolved on the real PATH before CLI mocks are installed. */
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
};

export async function runClaudeCodeWithMcp(
  options: ClaudeCodeMcpOptions,
): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const names = Object.keys(servers);
  const tools = new Set(
    names.flatMap((server) =>
      servers[server]!.tools.map((tool) => `mcp__${server}__${tool}`),
    ),
  );
  const extraArgs = mergeExtraArgs(
    options.extraArgs ?? [],
    (input.allowedMcpTools ?? []).map(
      ({server, tool}) => `mcp__${server}__${tool}`,
    ),
  );
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd: input.workDir,
    env,
    extendEnv: false,
    stdin: 'ignore' as const,
    reject: false as const,
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
      `Claude Code MCP mocking requires ${MIN_VERSION} or newer (found ${version ?? 'unknown'}).`,
    );

  const directory = await mkdtemp(join(tmpdir(), 'dynobox-claude-mcp-'));
  try {
    const configPath = join(directory, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: Object.fromEntries(
          names.map((name) => [name, {type: 'http', url: servers[name]!.url}]),
        ),
      }),
    );
    const child = execa(
      executable,
      [
        ...buildClaudeCodeArgs('', [], input.model, input.permissionMode).slice(
          0,
          -1,
        ),
        ...extraArgs,
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--',
        input.prompt,
      ],
      {...processOptions, timeout: remaining()},
    );
    let buffer = '';
    let ready = false;
    let completed = false;
    let failure: McpHarnessError | undefined;
    const consume = (line: string) => {
      if (!line.trim() || failure) return;
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) return;
        if (event.type === 'system' && event.subtype === 'init') {
          const problem = startupProblem(event, names, tools);
          if (problem !== undefined)
            throw new McpHarnessError('not_ready', problem);
          ready = true;
        }
        if (event.type === 'result') {
          if (event.is_error !== false || event.subtype !== 'success')
            throw new McpHarnessError(
              'execution_failed',
              `Claude Code reported an unsuccessful result (${String(event.subtype)}).`,
            );
          completed = true;
        }
        for (const tool of parseClaudeCodeStreamJsonLine(line).toolEvents)
          input.onToolEvent?.(tool);
      } catch (error) {
        failure =
          error instanceof McpHarnessError
            ? error
            : new McpHarnessError(
                'execution_failed',
                'Claude Code emitted unparseable stream-json output.',
              );
        child.kill();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    const result = await child;
    consume(buffer);
    remaining();
    if (failure) throw failure;
    if (result.failed)
      throw new McpHarnessError(
        'execution_failed',
        `Claude Code exited with code ${result.exitCode ?? 'unknown'}.`,
      );
    if (!ready)
      throw new McpHarnessError(
        'not_ready',
        'Claude Code never reported MCP startup.',
      );
    if (!completed)
      throw new McpHarnessError(
        'execution_failed',
        'Claude Code exited without a result event.',
      );
    return {
      harnessReady: true,
      output: {
        exitCode: result.exitCode ?? 1,
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
 * Reject flags that load other MCP servers and fold `--allow-mcp-tool` grants
 * into any `--allowedTools` list the harness already passes.
 */
function mergeExtraArgs(
  args: readonly string[],
  grants: readonly string[],
): string[] {
  const result: string[] = [];
  let merged = grants.length === 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equal = arg.indexOf('=');
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (MCP_CONFIG_FLAGS.has(flag))
      throw new McpHarnessError(
        'configuration_failed',
        `Claude Code extra argument ${flag} conflicts with MCP mocking.`,
      );
    if (!ALLOWED_TOOLS_FLAGS.has(flag)) {
      result.push(arg);
      continue;
    }
    if (merged && grants.length > 0)
      throw new McpHarnessError(
        'configuration_failed',
        'Claude Code extra arguments pass --allowedTools more than once.',
      );
    const value = equal === -1 ? args[++index] : arg.slice(equal + 1);
    if (value === undefined)
      throw new McpHarnessError(
        'configuration_failed',
        `Claude Code extra argument ${flag} is missing a value.`,
      );
    result.push(`${flag}=${[value, ...grants].join(',')}`);
    merged = true;
  }
  if (!merged) result.push(`--allowedTools=${grants.join(',')}`);
  return result;
}

/** Describe why the init event does not show every mock connected and usable. */
function startupProblem(
  event: Record<string, unknown>,
  names: readonly string[],
  tools: ReadonlySet<string>,
): string | undefined {
  const loaded = (
    Array.isArray(event.mcp_servers) ? event.mcp_servers : []
  ).filter(isRecord);
  // Strict config should load only the mocks; any other server breaks isolation.
  const inherited = loaded.find(
    (server) => !names.includes(String(server.name)),
  );
  if (inherited !== undefined)
    return `Claude Code loaded MCP server "${String(inherited.name)}", which is not a mock.`;
  const connected = new Set(
    loaded
      .filter((server) => server.status === 'connected')
      .map((server) => server.name),
  );
  const missingServer = names.find((name) => !connected.has(name));
  if (missingServer !== undefined)
    return `Claude Code did not connect MCP mock server "${missingServer}".`;
  const available = new Set(Array.isArray(event.tools) ? event.tools : []);
  const missingTool = [...tools].find((tool) => !available.has(tool));
  if (missingTool !== undefined)
    return `Claude Code did not expose MCP mock tool "${missingTool}"; check permission denials.`;
  return undefined;
}
