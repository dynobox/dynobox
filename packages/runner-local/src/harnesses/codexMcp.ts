import {randomBytes} from 'node:crypto';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {
  buildCodexArgs,
  createCodexToolEventDeduper,
  parseCodexJsonLine,
} from './codex.js';
import {asRecord, isRecord} from './parsing.js';
import {lineSplitter} from './runStreamingHarness.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
  ToolEvent,
} from './types.js';

const MIN_VERSION = '0.153.4';
const CONFIG_FLAGS = new Set([
  '-C',
  '--cd',
  '-c',
  '--config',
  '-p',
  '--profile',
  '--enable',
  '--disable',
  '--ignore-user-config',
  '--',
  'resume',
  'review',
]);
type RecordValue = Record<string, unknown>;

export type CodexMcpOptions = {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
};

/** Replace HTTP targets using fresh native identities; retain the normal profile and login. */
export async function runCodexWithMcp(
  options: CodexMcpOptions,
): Promise<McpHarnessRun> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const extras = options.extraArgs ?? [];
  for (const arg of extras) {
    const flag = arg.split('=')[0]!;
    if (CONFIG_FLAGS.has(flag) || /^-[cpC]./.test(arg))
      throw new McpHarnessError(
        'configuration_failed',
        `Codex extra argument ${flag} conflicts with MCP mocking.`,
      );
  }
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd: input.workDir,
    env,
    extendEnv: false,
    reject: false as const,
    forceKillAfterDelay: 1000,
    ...(input.signal ? {cancelSignal: input.signal} : {}),
  };
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...processOptions,
    stdin: 'ignore',
    timeout: Math.min(5000, remaining()),
  });
  let version: string;
  try {
    remaining();
    version = requireMcpVersion(
      'Codex',
      MIN_VERSION,
      probe,
      (stdout) => /^codex-cli (\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1] ?? null,
    );
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
  const aliases: Record<string, string> = {};
  const mcp: RecordValue = {};
  for (const [name, connection] of Object.entries(servers)) {
    const alias = `dxb_${randomBytes(16).toString('hex')}`;
    aliases[alias] = name;
    // A disabled entry still needs a valid transport when no original exists.
    // Existing HTTP credentials remain confined to this disabled entry.
    mcp[name] = {url: 'http://127.0.0.1:1', enabled: false};
    mcp[alias] = {
      url: connection.url,
      enabled: true,
      required: true,
      startup_timeout_sec: 10,
      tools: Object.fromEntries(
        (input.allowedMcpTools ?? [])
          .filter((grant) => grant.server === name)
          .map((grant) => [grant.tool, {approval_mode: 'approve'}]),
      ),
    };
  }
  const overlay = ['-c', `mcp_servers=${toml(mcp)}`];
  const ordinary = buildCodexArgs(
    '',
    [],
    input.model,
    input.permissionMode,
    input.cliMocksEnabled ? input.env : undefined,
  ).slice(1, -1);
  const configArgs: string[] = [];
  for (let i = 0; i < ordinary.length; i++)
    if (ordinary[i] === '-c') configArgs.push('-c', ordinary[++i]!);
  if (input.permissionMode === 'dangerous')
    configArgs.push('-c', 'sandbox_mode="danger-full-access"');
  if (input.model !== undefined)
    configArgs.push('-c', `model=${toml(input.model)}`);
  for (const [alias, name] of Object.entries(aliases)) {
    const args = [...configArgs, ...overlay];
    const original = await readDefinition(
      executable,
      args,
      name,
      processOptions,
      remaining,
    );
    const mock = await readDefinition(
      executable,
      args,
      alias,
      processOptions,
      remaining,
    );
    const transport = asRecord(mock.transport);
    if (
      original.enabled !== false ||
      mock.enabled !== true ||
      mock.disabled_reason != null ||
      transport.type !== 'streamable_http' ||
      transport.url !== servers[name]!.url ||
      transport.bearer_token_env_var != null ||
      transport.http_headers_helper != null ||
      Object.keys(asRecord(transport.http_headers)).length ||
      Object.keys(asRecord(transport.env_http_headers)).length
    )
      throw new McpHarnessError(
        'configuration_failed',
        `Codex cannot replace HTTP MCP target "${name}". Check managed configuration and target transport.`,
      );
    const enabled = mock.enabled_tools;
    const disabled = mock.disabled_tools;
    if (
      (enabled != null && !Array.isArray(enabled)) ||
      (disabled != null && !Array.isArray(disabled))
    )
      throw new McpHarnessError(
        'configuration_failed',
        'Codex returned invalid MCP tool availability.',
      );
    for (const tool of servers[name]!.tools)
      if (
        (Array.isArray(enabled) && !enabled.includes(tool)) ||
        (Array.isArray(disabled) && disabled.includes(tool))
      )
        throw new McpHarnessError(
          'not_ready',
          `Codex configuration hides MCP mock tool "${name}.${tool}".`,
        );
  }
  const child = startOwnedProcess(
    executable,
    ['exec', ...ordinary, ...extras, ...overlay, '--', input.prompt],
    {...processOptions, stdin: 'ignore', timeout: remaining()},
  );
  let completed = false;
  let lastError: string | undefined;
  let failure: McpHarnessError | undefined;
  const toolEvents: ToolEvent[] = [];
  const shouldEmit = createCodexToolEventDeduper();
  const lines = lineSplitter((line) => {
    if (!line.trim() || failure) return;
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) return;
      if (event.type === 'error') lastError = errorText(event, aliases);
      if (event.type === 'turn.failed')
        throw new McpHarnessError(
          'execution_failed',
          `Codex reported ${event.type}: ${errorText(event, aliases)}`,
        );
      if (event.type === 'turn.completed') completed = true;
      for (const tool of parseCodexJsonLine(line, 1, aliases).toolEvents) {
        if (!shouldEmit(tool, line)) continue;
        toolEvents.push(tool);
        input.onToolEvent?.(tool);
      }
    } catch (error) {
      failure =
        error instanceof McpHarnessError
          ? error
          : new McpHarnessError(
              'execution_failed',
              error instanceof SyntaxError
                ? 'Codex emitted unparseable JSON output.'
                : `Codex event processing failed: ${error instanceof Error ? error.message : String(error)}`,
            );
      child.stop();
    }
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => lines.write(chunk));
  const result = await child;
  const output = {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    metadata: {codexMcpAliases: aliases},
  };
  try {
    lines.flush();
    if (failure) throw failure;
    remaining();
    if (result.timedOut)
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    if (result.failed)
      throw new McpHarnessError(
        'execution_failed',
        `Codex exited with code ${result.exitCode ?? 'unknown'}.`,
      );
    if (!completed)
      throw new McpHarnessError(
        'execution_failed',
        `Codex exited without completing its turn${lastError === undefined ? '' : ` (last error: ${lastError})`}.`,
      );
    for (const [name, connection] of Object.entries(servers))
      if (connection.isDiscovered?.() === false)
        throw new McpHarnessError(
          'not_ready',
          `Codex did not discover MCP mock server "${name}".`,
        );
    return {harnessReady: true, version, toolEvents, output};
  } catch (error) {
    throw new McpHarnessError(
      error instanceof McpHarnessError ? error.category : 'execution_failed',
      error instanceof Error ? error.message : String(error),
      output,
    );
  }
}

/** Native metadata only; unlike mcp list, get does not initialize MCP clients. */
async function readDefinition(
  executable: string,
  args: string[],
  name: string,
  processOptions: Parameters<typeof startOwnedProcess>[2],
  remaining: () => number,
): Promise<RecordValue> {
  const result = await startOwnedProcess(
    executable,
    [...args, 'mcp', 'get', '--json', '--', name],
    {
      ...processOptions,
      stdin: 'ignore',
      timeout: Math.min(5000, remaining()),
    },
  );
  try {
    remaining();
    if (result.timedOut)
      throw new McpHarnessError(
        'timed_out',
        'Codex MCP configuration check exceeded its timeout.',
      );
    if (result.failed) throw new Error('configuration check');
    const value: unknown = JSON.parse(result.stdout);
    if (!isRecord(value) || value.name !== name) throw new Error('definition');
    return value;
  } catch (error) {
    throw new McpHarnessError(
      error instanceof McpHarnessError
        ? error.category
        : 'configuration_failed',
      error instanceof McpHarnessError
        ? error.message
        : 'Codex could not load HTTP MCP mock configuration. Check target transports and managed configuration; see --debug for details.',
      {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    );
  }
}

function errorText(
  event: RecordValue,
  aliases: Readonly<Record<string, string>>,
): string {
  const error = asRecord(event.error);
  let message = String(error.message ?? event.message ?? 'no details');
  for (const [native, logical] of Object.entries(aliases))
    message = message.split(native).join(logical);
  return message;
}

/** Convert the small generated overlay to TOML, keeping original credentials out of arguments. */
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
