import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

import {execa} from 'execa';

import {buildCodexArgs, parseCodexJsonLine} from './codex.js';
import {cachedCodexPluginServers} from './codexMcpPlugins.js';
import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
  ToolEvent,
} from './types.js';
import {isAtLeastVersion} from './version.js';

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
const CONFIG_FLAGS = new Set([
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
): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const extras = options.extraArgs ?? [];
  for (const arg of extras) {
    const flag = arg.split('=')[0]!;
    if (CONFIG_FLAGS.has(flag) || /^-[cp]./.test(arg))
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
  const version = /^codex-cli (\d+\.\d+\.\d+)/.exec(probe.stdout.trim())?.[1];
  if (probe.failed || !isAtLeastVersion(version ?? null, MIN_VERSION))
    throw new McpHarnessError(
      'unsupported_version',
      `Codex MCP mocking requires ${MIN_VERSION} or newer (found ${version ?? 'unknown'}).`,
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
  const {overlay, logicalNames} = buildOverlay(
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
  let buffer = '';
  let completed = false;
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
      if (event.type === 'error' || event.type === 'turn.failed')
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
        const logical = logicalNames[String(item.server)];
        if (logical === undefined)
          throw new McpHarnessError(
            'not_ready',
            `Codex called MCP server "${String(item.server)}", which is not a mock.`,
          );
        emit(
          createToolEvent(
            `mcp__${logical}__${String(item.tool)}`,
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
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      consume(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  const result = await child;
  consume(buffer);
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
      'Codex exited without completing its turn.',
    );
  return {
    harnessReady: true,
    output: {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      metadata: {mcpHarnessVersion: version, mcpRunToolEvents: toolEvents},
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
  let buffer = '';
  const rejectAll = () => {
    for (const waiter of pending.values()) {
      let error = new McpHarnessError(
        'configuration_failed',
        `Codex app-server exited during ${waiter.method}.`,
      );
      try {
        remaining();
      } catch (deadline) {
        // Report cancellation or timeout rather than the resulting exit.
        error = deadline as McpHarnessError;
      }
      waiter.reject(error);
    }
    pending.clear();
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || typeof message.id !== 'number') continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error !== undefined || !Object.hasOwn(message, 'result'))
        waiter.reject(
          new McpHarnessError(
            'configuration_failed',
            `Codex app-server ${waiter.method} failed.`,
          ),
        );
      else waiter.resolve(message.result);
    }
  });
  child.then(rejectAll, rejectAll);
  const rpc = async (method: string, params: object): Promise<RecordValue> => {
    remaining();
    const id = ++nextId;
    const value = await new Promise<unknown>((resolve, reject) => {
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
    const config = record(
      (await rpc('config/read', {includeLayers: false, cwd})).config,
    );
    for (const name of GUARDED_FEATURES)
      if (record(config.features)[name] !== false)
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
        const detail = record(
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
    for (const [id, value] of Object.entries(record(config.plugins)))
      if (record(value).enabled !== false && !seen.has(id))
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
  const inherited = record(snapshot.config.mcp_servers);
  // Disabling needs a valid transport, but never the inherited one.
  const mcp: RecordValue = Object.fromEntries(
    Object.entries(inherited).map(([name, value]) => [
      name,
      {
        enabled: false,
        ...(typeof record(value).command === 'string'
          ? {command: process.execPath}
          : {url: 'http://127.0.0.1:1'}),
      },
    ]),
  );
  const plugins: RecordValue = {};
  const occupied = new Set(Object.keys(inherited));
  for (const plugin of snapshot.plugins) {
    plugins[plugin.id] = {
      mcp_servers: Object.fromEntries(
        plugin.servers.map((name) => [name, {enabled: false}]),
      ),
    };
    for (const name of plugin.servers) occupied.add(name);
  }
  const logicalNames: Record<string, string> = {};
  for (const [logical, server] of Object.entries(servers)) {
    // A same-named inherited server keeps its tool policy for the mock.
    const policy = record(inherited[logical]);
    if (policy.enabled === false)
      throw new McpHarnessError(
        'not_ready',
        `Codex config disables MCP server "${logical}".`,
      );
    for (const tool of server.tools)
      if (
        (Array.isArray(policy.enabled_tools) &&
          !policy.enabled_tools.includes(tool)) ||
        (Array.isArray(policy.disabled_tools) &&
          policy.disabled_tools.includes(tool))
      )
        throw new McpHarnessError(
          'not_ready',
          `Codex config disables MCP tool "${logical}/${tool}".`,
        );
    let name = logical;
    for (let suffix = 1; occupied.has(name); suffix++)
      name = `dynobox_${logical}_${suffix}`;
    occupied.add(name);
    const entry: RecordValue = {
      url: server.url,
      enabled: true,
      required: true,
      startup_timeout_sec: 10,
    };
    for (const key of [
      'default_tools_approval_mode',
      'enabled_tools',
      'disabled_tools',
      'tools',
      'tool_timeout_sec',
    ])
      if (policy[key] !== undefined && policy[key] !== null)
        entry[key] = structuredClone(policy[key]);
    for (const grant of grants.filter((grant) => grant.server === logical)) {
      const tools = {...record(entry.tools)};
      tools[grant.tool] = {
        ...record(tools[grant.tool]),
        approval_mode: 'approve',
      };
      entry.tools = tools;
    }
    mcp[name] = entry;
    logicalNames[name] = logical;
  }
  return {
    overlay: [
      '-c',
      `mcp_servers=${toml(mcp)}`,
      '-c',
      `plugins=${toml(plugins)}`,
    ],
    logicalNames,
  };
}

function record(value: unknown): RecordValue {
  return isRecord(value) ? value : {};
}

function errorText(event: RecordValue): string {
  const error = record(event.error);
  return String(error.message ?? event.message ?? 'no details');
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
