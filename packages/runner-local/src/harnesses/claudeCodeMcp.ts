import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {execa} from 'execa';

import {
  buildClaudeCodeArgs,
  parseClaudeCodeStreamJsonLine,
} from './claudeCode.js';
import {mcpDeadline, McpHarnessError, requireMcpVersion} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {isRecord} from './parsing.js';
import {lineSplitter} from './runStreamingHarness.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

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
): Promise<McpHarnessRun> {
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
  const version = requireMcpVersion('Claude Code', MIN_VERSION, probe);

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
          // A denied call never reaches the mock, so it would otherwise let
          // a negative assertion pass.
          const denied = (
            Array.isArray(event.permission_denials)
              ? event.permission_denials
              : []
          )
            .map((denial) => (isRecord(denial) ? denial.tool_name : undefined))
            .find(
              (name) =>
                typeof name === 'string' &&
                names.some((server) => name.startsWith(`mcp__${server}__`)),
            );
          if (denied !== undefined)
            throw new McpHarnessError(
              'execution_failed',
              `Claude Code denied permission for mock tool ${String(denied)}. Check the Claude Code permission settings.`,
            );
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
    const lines = lineSplitter(consume);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => lines.write(chunk));
    const result = await child;
    lines.flush();
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
      version,
      output: {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

/**
 * Reject flags that load other MCP servers and fold declared mock tools into
 * any `--allowedTools` list the harness already passes.
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
    if (value === undefined || value.length === 0)
      throw new McpHarnessError(
        'configuration_failed',
        `Claude Code extra argument ${flag} is missing a value.`,
      );
    if (grants.length === 0) {
      result.push(...(equal === -1 ? [flag, value] : [arg]));
    } else if (equal === -1) {
      // This flag accepts several space-separated tools. Keep subsequent
      // values attached to it instead of turning them into prompt arguments.
      result.push(flag, value);
      while (args[index + 1] !== undefined && !args[index + 1]!.startsWith('-'))
        result.push(args[++index]!);
      result.push(...grants);
    } else {
      result.push(flag, value, ...grants);
    }
    merged = true;
  }
  if (!merged) result.push('--allowedTools', ...grants);
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
