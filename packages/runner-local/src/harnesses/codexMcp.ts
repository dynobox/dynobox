import {randomBytes} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';

import {execa} from 'execa';

import {buildCodexArgs, parseCodexJsonLine} from './codex.js';
import {cachedCodexPluginServers} from './codexMcpPlugins.js';
import {createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
  ToolEvent,
} from './types.js';

// Invocation-local compatibility gate. Native tests must be rerun before changing.
const CANDIDATE_VERSION = '0.153.4';
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const GUARDED_FEATURES = [
  'apps',
  'remote_plugin',
  'skill_mcp_dependency_install',
] as const;
const GUARDS = GUARDED_FEATURES.flatMap((name) => ['--disable', name]);
type RecordValue = Record<string, unknown>;
type Plugin = {id: string; servers: string[]};
type Snapshot = {config: RecordValue; plugins: Plugin[]};

export type CodexMcpOptions = {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
  signal?: AbortSignal;
};

export class CodexMcpError extends Error {
  constructor(
    readonly category:
      | 'configuration_failed'
      | 'unsupported_version'
      | 'not_ready'
      | 'execution_failed'
      | 'cleanup_failed',
  ) {
    // Subprocess errors contain private configuration, URLs and credentials.
    super(`Codex MCP ${category}.`);
    this.name = 'CodexMcpError';
  }
}

/** The controller owns discovery evidence, sealing, route revocation and cleanup. */
export async function runCodexWithMcp(
  options: CodexMcpOptions,
): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = performance.now();
  const input = {
    ...options.input,
    env: {...options.input.env},
    allowedMcpTools: options.input.allowedMcpTools?.map((tool) => ({...tool})),
  };
  const servers = structuredClone(options.servers);
  const timeout = input.timeoutMs ?? 120_000;
  const signal = options.signal ?? input.signal;
  const remaining = () => {
    const value = Math.ceil(timeout - (performance.now() - started));
    if (value <= 0 || signal?.aborted)
      throw new CodexMcpError('execution_failed');
    return value;
  };
  try {
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      input.prompt.includes('\0') ||
      (input.model !== undefined &&
        (!input.model || /^[-\s]|\0/.test(input.model)))
    )
      failConfig();
    const extras = safeExtraArgs(options.extraArgs ?? []);
    validateServers(servers);
    for (const grant of input.allowedMcpTools ?? []) {
      if (
        !Object.hasOwn(servers, grant.server) ||
        !servers[grant.server]!.tools.includes(grant.tool)
      )
        failConfig();
    }
    const executable = await realpath(options.executable);
    const cwd = await realpath(input.workDir);
    const env = {...process.env, ...input.env};
    const noProxy = [
      ...new Set(
        [env.NO_PROXY ?? '', env.no_proxy ?? '', '127.0.0.1,localhost,::1']
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].join(',');
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
    const processOptions = {
      cwd,
      env,
      extendEnv: false,
      reject: false as const,
      maxBuffer: OUTPUT_LIMIT,
      forceKillAfterDelay: 1000,
      ...(signal === undefined ? {} : {cancelSignal: signal}),
    };
    const version = await execa(executable, [...GUARDS, '--version'], {
      ...processOptions,
      stdin: 'ignore',
      timeout: Math.min(5000, remaining()),
    });
    if (
      version.failed ||
      version.stdout.trim() !== `codex-cli ${CANDIDATE_VERSION}`
    )
      throw new CodexMcpError('unsupported_version');

    // All policy/model/CLI-mock config used for execution also applies to probes.
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
    // --sandbox/--model are exec-only flags; represent them identically in probes.
    if (input.permissionMode === 'dangerous')
      configArgs.push('-c', 'sandbox_mode="danger-full-access"');
    if (input.model !== undefined)
      configArgs.push('-c', `model=${toml(input.model)}`);

    const snapshot = async (args: string[]): Promise<Snapshot> => {
      const child = execa(executable, [...args, 'app-server', '--stdio'], {
        ...processOptions,
        timeout: remaining(),
      });
      let buffer = '';
      let nextId = 0;
      let bytes = 0;
      const pending = new Map<
        number,
        {resolve(value: unknown): void; reject(error: Error): void}
      >();
      let ended = false;
      const rejectPending = () => {
        ended = true;
        for (const waiter of pending.values())
          waiter.reject(
            new CodexMcpError(
              signal?.aborted ? 'execution_failed' : 'configuration_failed',
            ),
          );
        pending.clear();
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        try {
          bytes += Buffer.byteLength(chunk);
          if (bytes > OUTPUT_LIMIT) failConfig();
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const event: unknown = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (!isRecord(event)) failConfig();
            if (typeof event.id !== 'number') continue;
            const waiter = pending.get(event.id);
            if (
              !waiter ||
              event.error !== undefined ||
              !Object.hasOwn(event, 'result')
            )
              failConfig();
            pending.delete(event.id);
            waiter.resolve(event.result);
          }
        } catch {
          rejectPending();
          child.kill();
        }
      });
      child.then(rejectPending, rejectPending);
      const rpc = (method: string, params: object): Promise<unknown> => {
        remaining();
        if (ended) failConfig();
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, {resolve, reject});
          child.stdin!.write(
            `${JSON.stringify({id, method, params})}\n`,
            (error) => {
              if (error) rejectPending();
            },
          );
        });
      };
      try {
        await rpc('initialize', {
          clientInfo: {name: 'dynobox', version: '1'},
          capabilities: {experimentalApi: true},
        });
        const requirements = record(await rpc('configRequirements/read', {}));
        if (!Object.hasOwn(requirements, 'requirements')) failConfig();
        const featureRequirements = optionalRecord(
          optionalRecord(requirements.requirements).featureRequirements,
        );
        for (const name of GUARDED_FEATURES)
          if (featureRequirements[name] === true) failConfig();
        const read = record(
          await rpc('config/read', {includeLayers: false, cwd}),
        );
        const config = record(read.config);
        for (const name of GUARDED_FEATURES)
          if (record(config.features)[name] !== false) failConfig();
        const catalog = record(
          await rpc('plugin/list', {cwds: [cwd], forceRefetch: false}),
        );
        if (
          !Array.isArray(catalog.marketplaces) ||
          !Array.isArray(catalog.marketplaceLoadErrors) ||
          catalog.marketplaceLoadErrors.length
        )
          failConfig();
        const plugins: Plugin[] = [];
        const cachedServers = async (id: string) => {
          try {
            return await cachedCodexPluginServers(
              resolve(
                cwd,
                env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'),
              ),
              id,
            );
          } catch {
            return failConfig();
          }
        };
        const seen = new Set<string>();
        for (const value of catalog.marketplaces) {
          const marketplace = record(value);
          if (!Array.isArray(marketplace.plugins)) failConfig();
          for (const item of marketplace.plugins) {
            const plugin = record(item);
            if (
              typeof plugin.installed !== 'boolean' ||
              typeof plugin.enabled !== 'boolean'
            )
              failConfig();
            if (!plugin.installed || !plugin.enabled) continue;
            if (
              typeof plugin.id !== 'string' ||
              typeof plugin.name !== 'string' ||
              typeof marketplace.path !== 'string' ||
              seen.has(plugin.id)
            )
              failConfig();
            seen.add(plugin.id);
            const detail = record(
              record(
                await rpc('plugin/read', {
                  marketplacePath: marketplace.path,
                  pluginName: plugin.name,
                }),
              ).plugin,
            );
            if (
              !Array.isArray(detail.mcpServers) ||
              !detail.mcpServers.every((name) => typeof name === 'string')
            )
              failConfig();
            plugins.push({
              id: plugin.id,
              servers: [
                ...new Set([
                  ...(detail.mcpServers as string[]),
                  ...(await cachedServers(plugin.id)),
                ]),
              ].sort(),
            });
          }
        }
        // Enabled cached plugins can load even after their marketplace disappears.
        // Enumerate every cached version without copying transports or credentials.
        for (const [id, value] of Object.entries(
          optionalRecord(config.plugins),
        )) {
          if (record(value).enabled !== false && !seen.has(id)) {
            plugins.push({id, servers: await cachedServers(id)});
          }
        }
        return {config, plugins};
      } finally {
        child.kill();
        await child;
        rejectPending();
      }
    };

    // Unlike `mcp list`, these metadata APIs do not perform OAuth status probes.
    const initial = await snapshot(configArgs);
    const {overlay, expected, logicalNames} = buildOverlay(
      initial,
      servers,
      input.allowedMcpTools ?? [],
    );
    const launchConfig = [...configArgs, ...overlay];
    const resolved = await snapshot(launchConfig);
    verifySnapshot(resolved, initial.plugins, expected);

    // Only after disabling every inherited source may this command query auth
    // status. It also detects managed allowlists that disable generated servers.
    const listing = await execa(
      executable,
      [...launchConfig, 'mcp', 'list', '--json'],
      {...processOptions, stdin: 'ignore', timeout: remaining()},
    );
    if (listing.failed || !listingMatches(JSON.parse(listing.stdout), expected))
      throw new CodexMcpError('not_ready');

    const child = execa(
      executable,
      ['exec', ...ordinary, ...extras, ...launchConfig, '--', input.prompt],
      {...processOptions, stdin: 'ignore', timeout: remaining()},
    );
    let buffer = '';
    let completed = false;
    let failed = false;
    let bytes = 0;
    const toolEvents: ToolEvent[] = [];
    const emit = (event: ToolEvent) => {
      toolEvents.push(event);
      input.onToolEvent?.(event);
    };
    const consume = (line: string) => {
      if (!line.trim() || failed) return;
      try {
        const event = record(JSON.parse(line));
        if (event.type === 'error' || event.type === 'turn.failed')
          throw new CodexMcpError('execution_failed');
        if (event.type === 'turn.completed') {
          if (completed) throw new CodexMcpError('execution_failed');
          completed = true;
        }
        if (
          event.type === 'item.completed' &&
          isRecord(event.item) &&
          event.item.type === 'mcp_tool_call'
        ) {
          const item = event.item;
          if (
            typeof item.server !== 'string' ||
            !Object.hasOwn(logicalNames, item.server) ||
            typeof item.tool !== 'string' ||
            !servers[logicalNames[item.server]!]!.tools.includes(item.tool)
          )
            throw new CodexMcpError('not_ready');
          emit(
            createToolEvent(
              `mcp__${logicalNames[item.server]}__${item.tool}`,
              item.arguments,
              item.status === 'completed' ? 'success' : 'failure',
            ),
          );
        } else
          for (const tool of parseCodexJsonLine(line).toolEvents) emit(tool);
      } catch {
        failed = true;
        child.kill();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        failed = true;
        child.kill();
        return;
      }
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
    if (failed || result.failed) throw new CodexMcpError('execution_failed');
    if (!completed) throw new CodexMcpError('not_ready');
    return {
      harnessReady: true,
      output: {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: performance.now() - started,
        metadata: {
          mcpHarnessVersion: CANDIDATE_VERSION,
          mcpRunToolEvents: toolEvents,
        },
      },
    };
  } catch (error) {
    if (error instanceof CodexMcpError) throw error;
    throw new CodexMcpError('execution_failed');
  }
}

function buildOverlay(
  snapshot: Snapshot,
  servers: McpServerConnections,
  grants: readonly {server: string; tool: string}[],
) {
  const inherited = optionalRecord(snapshot.config.mcp_servers);
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
  const expected: Record<string, RecordValue> = {};
  const logicalNames: Record<string, string> = {};
  for (const [logical, server] of Object.entries(servers)) {
    const sources: RecordValue[] = [];
    if (Object.hasOwn(inherited, logical))
      sources.push(record(inherited[logical]));
    for (const plugin of snapshot.plugins)
      if (plugin.servers.includes(logical)) {
        const config = optionalRecord(
          optionalRecord(snapshot.config.plugins)[plugin.id],
        );
        sources.push(
          optionalRecord(optionalRecord(config.mcp_servers)[logical]),
        );
      }
    if (sources.length > 1) failConfig();
    const policy = sources[0] ?? {};
    if (policy.enabled === false) throw new CodexMcpError('not_ready');
    for (const tool of server.tools) {
      if (
        (Array.isArray(policy.enabled_tools) &&
          !policy.enabled_tools.includes(tool)) ||
        (Array.isArray(policy.disabled_tools) &&
          policy.disabled_tools.includes(tool))
      )
        throw new CodexMcpError('not_ready');
    }
    let name = logical;
    while (occupied.has(name)) name = `dxb_${randomBytes(12).toString('hex')}`;
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
      const tools = {...optionalRecord(entry.tools)};
      tools[grant.tool] = {
        ...optionalRecord(tools[grant.tool]),
        approval_mode: 'approve',
      };
      entry.tools = tools;
    }
    mcp[name] = entry;
    expected[name] = entry;
    logicalNames[name] = logical;
  }
  return {
    overlay: [
      '-c',
      `mcp_servers=${toml(mcp)}`,
      '-c',
      `plugins=${toml(plugins)}`,
    ],
    expected,
    logicalNames,
  };
}

function verifySnapshot(
  snapshot: Snapshot,
  originalPlugins: Plugin[],
  expected: Record<string, RecordValue>,
) {
  if (!isDeepStrictEqual(snapshot.plugins, originalPlugins)) failConfig();
  for (const plugin of snapshot.plugins) {
    const config = optionalRecord(
      optionalRecord(snapshot.config.plugins)[plugin.id],
    );
    const servers = optionalRecord(config.mcp_servers);
    for (const name of plugin.servers)
      if (optionalRecord(servers[name]).enabled !== false) failConfig();
  }
  const actual = optionalRecord(snapshot.config.mcp_servers);
  for (const [name, value] of Object.entries(actual)) {
    const entry = record(value);
    if (!Object.hasOwn(expected, name)) {
      if (entry.enabled !== false) failConfig();
      continue;
    }
    const wanted = expected[name]!;
    if (entry.enabled !== true || entry.required !== true)
      throw new CodexMcpError('not_ready');
    // Effective defaults are emitted by config/read. Allow only known inert
    // defaults in addition to exactly the generated transport and copied policy.
    for (const [key, value] of Object.entries(entry)) {
      if (Object.hasOwn(wanted, key)) {
        if (!isDeepStrictEqual(value, wanted[key])) failConfig();
      } else if (
        !(value === null || (key === 'environment_id' && value === 'local'))
      )
        failConfig();
    }
    for (const [key, value] of Object.entries(wanted))
      if (!isDeepStrictEqual(entry[key], value)) failConfig();
  }
  for (const name of Object.keys(expected))
    if (!Object.hasOwn(actual, name)) throw new CodexMcpError('not_ready');
}

function listingMatches(value: unknown, expected: Record<string, RecordValue>) {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.enabled !== 'boolean' ||
      seen.has(item.name)
    )
      return false;
    seen.add(item.name);
    if (!item.enabled) {
      if (Object.hasOwn(expected, item.name)) return false;
      continue;
    }
    if (
      !Object.hasOwn(expected, item.name) ||
      item.disabled_reason !== null ||
      !isRecord(item.transport)
    )
      return false;
    const transport = item.transport;
    if (
      transport.type !== 'streamable_http' ||
      transport.url !== expected[item.name]!.url
    )
      return false;
    for (const [key, value] of Object.entries(transport))
      if (!['type', 'url'].includes(key) && value !== null) return false;
  }
  return Object.keys(expected).every((name) => seen.has(name));
}

function validateServers(servers: McpServerConnections) {
  if (Object.keys(servers).length === 0) failConfig();
  const names = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  for (const [name, server] of Object.entries(servers)) {
    const url = new URL(server.url);
    if (
      !names.test(name) ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[a-f0-9]{48}$/.test(url.pathname) ||
      !server.tools.length ||
      new Set(server.tools).size !== server.tools.length ||
      !server.tools.every((tool) => names.test(tool))
    )
      failConfig();
  }
}

function safeExtraArgs(args: readonly string[]) {
  // Exec-only, configuration-free flags. All policy/model settings use typed input.
  if (args.some((arg) => arg !== '--ephemeral') || args.length > 1)
    failConfig();
  return [...args];
}

function record(value: unknown): RecordValue {
  if (!isRecord(value)) failConfig();
  return value;
}
function optionalRecord(value: unknown): RecordValue {
  return value === undefined || value === null ? {} : record(value);
}
function failConfig(): never {
  throw new CodexMcpError('configuration_failed');
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`;
  if (
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  )
    failConfig();
  return JSON.stringify(value);
}
