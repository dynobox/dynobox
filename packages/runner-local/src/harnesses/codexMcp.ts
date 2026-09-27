import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

import {execa} from 'execa';

import {buildCodexArgs, parseCodexJsonLine} from './codex.js';
import {cachedCodexPluginServers} from './codexMcpPlugins.js';
import {mcpDeadline, McpHarnessError, requireMcpVersion} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {asRecord, createToolEvent, isRecord} from './parsing.js';
import {lineSplitter} from './runStreamingHarness.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
  ToolEvent,
} from './types.js';

// Oldest release whose overlay isolation was verified natively.
const MIN_VERSION = '0.153.4';
// Features that can attach MCP servers the overlay cannot enumerate.
const GUARDED_FEATURES = [
  'apps',
  'remote_plugin',
  'skill_mcp_dependency_install',
] as const;
const GUARDS = GUARDED_FEATURES.flatMap((name) => ['--disable', name]);
// Extra arguments that would change the configuration the overlay is built on.
// -C/--cd moves the project whose config Codex loads away from the snapshot's.
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
]);
type RecordValue = Record<string, unknown>;
type Plugin = {id: string; servers: string[]};
type Snapshot = {config: RecordValue; plugins: Plugin[]};

export type CodexMcpOptions = {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
};

/**
 * Codex has no strict MCP mode. Read the effective configuration, then launch
 * with an overlay that disables every inherited MCP server (including plugin
 * servers) and adds the mocks. Skills and other settings stay intact.
 */
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
  const cwd = input.workDir;
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd,
    env,
    extendEnv: false,
    reject: false as const,
    forceKillAfterDelay: 1000,
    ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
  };
  const probe = await execa(executable, [...GUARDS, '--version'], {
    ...processOptions,
    stdin: 'ignore',
    timeout: Math.min(5000, remaining()),
  });
  remaining();
  const version = requireMcpVersion(
    'Codex',
    MIN_VERSION,
    probe,
    (stdout) => /^codex-cli (\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1] ?? null,
  );

  // Model, permission and CLI-mock settings must also apply to the config read.
  const ordinary = buildCodexArgs(
    '',
    [],
    input.model,
    input.permissionMode,
    input.cliMocksEnabled ? input.env : undefined,
  ).slice(1, -1);
  const configArgs: string[] = [...GUARDS];
  for (let index = 0; index < ordinary.length; index++) {
    if (ordinary[index] === '-c') configArgs.push('-c', ordinary[++index]!);
  }
  // --sandbox/--model are exec-only flags; represent them as config for reads.
  if (input.permissionMode === 'dangerous')
    configArgs.push('-c', 'sandbox_mode="danger-full-access"');
  if (input.model !== undefined)
    configArgs.push('-c', `model=${toml(input.model)}`);

  const snapshot = await readSnapshot(
    executable,
    configArgs,
    cwd,
    env,
    processOptions,
    remaining,
  );
  const {overlay} = buildOverlay(
    snapshot,
    servers,
    input.allowedMcpTools ?? [],
  );

  const child = execa(
    executable,
    [
      'exec',
      ...ordinary,
      ...extras,
      ...configArgs,
      ...overlay,
      '--',
      input.prompt,
    ],
    {...processOptions, stdin: 'ignore', timeout: remaining()},
  );
  let completed = false;
  let lastError: string | undefined;
  let failure: McpHarnessError | undefined;
  const toolEvents: ToolEvent[] = [];
  const emit = (event: ToolEvent) => {
    toolEvents.push(event);
    input.onToolEvent?.(event);
  };
  const consume = (line: string) => {
    if (!line.trim() || failure) return;
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) return;
      // Codex also reports recoverable problems (stream reconnects) as
      // `error` events; only a failed or unfinished turn is fatal.
      if (event.type === 'error') lastError = errorText(event);
      if (event.type === 'turn.failed')
        throw new McpHarnessError(
          'execution_failed',
          `Codex reported ${event.type}: ${errorText(event)}`,
        );
      if (event.type === 'turn.completed') completed = true;
      const item = event.item;
      if (
        event.type === 'item.completed' &&
        isRecord(item) &&
        item.type === 'mcp_tool_call'
      ) {
        const server = String(item.server);
        if (!Object.hasOwn(servers, server))
          throw new McpHarnessError(
            'not_ready',
            `Codex called MCP server "${server}", which is not a mock.`,
          );
        // A call refused for approval never reaches the mock, so it would
        // otherwise let a negative assertion pass.
        if (
          item.status !== 'completed' &&
          /approval/i.test(String(asRecord(item.error).message))
        )
          throw new McpHarnessError(
            'execution_failed',
            `Codex refused mock tool mcp__${server}__${String(item.tool)} without approval. Check the Codex permission settings.`,
          );
        emit(
          createToolEvent(
            `mcp__${server}__${String(item.tool)}`,
            item.arguments,
            item.status === 'completed' ? 'success' : 'failure',
          ),
        );
      } else for (const tool of parseCodexJsonLine(line).toolEvents) emit(tool);
    } catch (error) {
      failure =
        error instanceof McpHarnessError
          ? error
          : new McpHarnessError(
              'execution_failed',
              'Codex emitted unparseable JSON output.',
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
      `Codex exited with code ${result.exitCode ?? 'unknown'}.`,
    );
  if (!completed)
    throw new McpHarnessError(
      'execution_failed',
      `Codex exited without completing its turn${lastError === undefined ? '' : ` (last error: ${lastError})`}.`,
    );
  return {
    harnessReady: true,
    version,
    toolEvents,
    output: {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    },
  };
}

/** Read effective config and every enabled plugin's MCP servers via app-server. */
async function readSnapshot(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  processOptions: object,
  remaining: () => number,
): Promise<Snapshot> {
  const child = execa(executable, [...args, 'app-server', '--stdio'], {
    ...processOptions,
    timeout: remaining(),
  });
  const pending = new Map<
    number,
    {method: string; resolve(value: unknown): void; reject(error: Error): void}
  >();
  let nextId = 0;
  let exited = false;
  const exitError = (method: string) => {
    try {
      remaining();
    } catch (deadline) {
      // Report cancellation or timeout rather than the resulting exit.
      return deadline as McpHarnessError;
    }
    return new McpHarnessError(
      'configuration_failed',
      `Codex app-server exited during ${method}.`,
    );
  };
  const rejectAll = () => {
    exited = true;
    for (const waiter of pending.values())
      waiter.reject(exitError(waiter.method));
    pending.clear();
  };
  const lines = lineSplitter((line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error !== undefined || !Object.hasOwn(message, 'result'))
      waiter.reject(
        new McpHarnessError(
          'configuration_failed',
          `Codex app-server ${waiter.method} failed.`,
        ),
      );
    else waiter.resolve(message.result);
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => lines.write(chunk));
  child.then(rejectAll, rejectAll);
  const rpc = async (method: string, params: object): Promise<RecordValue> => {
    remaining();
    const id = ++nextId;
    const value = await new Promise<unknown>((resolve, reject) => {
      // A request written after exit would never get a reply.
      if (exited) return reject(exitError(method));
      pending.set(id, {method, resolve, reject});
      child.stdin!.write(`${JSON.stringify({id, method, params})}\n`);
    });
    return isRecord(value) ? value : {};
  };
  try {
    await rpc('initialize', {
      clientInfo: {name: 'dynobox', version: '1'},
      capabilities: {experimentalApi: true},
    });
    const config = asRecord(
      (await rpc('config/read', {includeLayers: false, cwd})).config,
    );
    for (const name of GUARDED_FEATURES)
      if (asRecord(config.features)[name] !== false)
        throw new McpHarnessError(
          'configuration_failed',
          `Codex feature "${name}" is forced on and could load MCP servers beside the mocks.`,
        );
    const catalog = await rpc('plugin/list', {
      cwds: [cwd],
      forceRefetch: false,
    });
    const codexHome = resolve(
      cwd,
      env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'),
    );
    const plugins: Plugin[] = [];
    const seen = new Set<string>();
    const marketplaces = Array.isArray(catalog.marketplaces)
      ? catalog.marketplaces
      : [];
    for (const marketplace of marketplaces.filter(isRecord)) {
      const entries = Array.isArray(marketplace.plugins)
        ? marketplace.plugins
        : [];
      for (const plugin of entries.filter(isRecord)) {
        if (
          !plugin.installed ||
          !plugin.enabled ||
          typeof plugin.id !== 'string'
        )
          continue;
        seen.add(plugin.id);
        const detail = asRecord(
          (
            await rpc('plugin/read', {
              marketplacePath: marketplace.path,
              pluginName: plugin.name,
            })
          ).plugin,
        );
        const listed = Array.isArray(detail.mcpServers)
          ? detail.mcpServers.map(String)
          : [];
        plugins.push({
          id: plugin.id,
          servers: [
            ...new Set([
              ...listed,
              ...(await cachedCodexPluginServers(codexHome, plugin.id)),
            ]),
          ],
        });
      }
    }
    // Enabled cached plugins can load even after their marketplace disappears.
    for (const [id, value] of Object.entries(asRecord(config.plugins)))
      if (asRecord(value).enabled !== false && !seen.has(id))
        plugins.push({
          id,
          servers: await cachedCodexPluginServers(codexHome, id),
        });
    return {config, plugins};
  } finally {
    child.kill();
    await child;
  }
}

function buildOverlay(
  snapshot: Snapshot,
  servers: McpServerConnections,
  grants: readonly {server: string; tool: string}[],
) {
  const inherited = asRecord(snapshot.config.mcp_servers);
  // Disabling needs a valid transport, but never the inherited one.
  const mcp: RecordValue = Object.fromEntries(
    Object.entries(inherited).map(([name, value]) => [
      name,
      {
        enabled: false,
        ...(typeof asRecord(value).command === 'string'
          ? {command: process.execPath}
          : {url: 'http://127.0.0.1:1'}),
      },
    ]),
  );
  // Start from the effective plugins table so each plugin keeps its own
  // settings (such as `enabled`) whether Codex merges or replaces the table.
  const plugins: RecordValue = {...asRecord(snapshot.config.plugins)};
  const occupied = new Set(Object.keys(inherited));
  for (const plugin of snapshot.plugins) {
    const current = asRecord(plugins[plugin.id]);
    plugins[plugin.id] = {
      ...current,
      enabled: true,
      mcp_servers: {
        ...asRecord(current.mcp_servers),
        ...Object.fromEntries(
          plugin.servers.map((name) => [name, {enabled: false}]),
        ),
      },
    };
    for (const name of plugin.servers) occupied.add(name);
  }
  for (const [name, server] of Object.entries(servers)) {
    // Renaming the mock would show the model a different tool name than
    // other harnesses, so a name clash fails instead.
    if (occupied.has(name))
      throw new McpHarnessError(
        'configuration_failed',
        `Codex config already has an MCP server named "${name}"; rename or remove it to use this mock.`,
      );
    const entry: RecordValue = {
      url: server.url,
      enabled: true,
      required: true,
      startup_timeout_sec: 10,
    };
    for (const grant of grants.filter((grant) => grant.server === name))
      entry.tools = {
        ...asRecord(entry.tools),
        [grant.tool]: {approval_mode: 'approve'},
      };
    mcp[name] = entry;
  }
  return {
    overlay: [
      '-c',
      `mcp_servers=${toml(mcp)}`,
      '-c',
      `plugins=${toml(plugins)}`,
    ],
  };
}

function errorText(event: RecordValue): string {
  const error = asRecord(event.error);
  return String(error.message ?? event.message ?? 'no details');
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (isRecord(value))
    // TOML has no null; an absent key means the same.
    return `{${Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
