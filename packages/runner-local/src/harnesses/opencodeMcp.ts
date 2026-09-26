import {randomBytes} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';

import {execa} from 'execa';

import {mcpProxyEnv} from './mcpProxyEnv.js';
import {parseOpenCodeJson} from './opencode.js';
import {checkOpenCodeConfigReads} from './opencodeMcpConfig.js';
import {createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';

const CANDIDATE_VERSION = '1.18.26';
const OUTPUT_LIMIT = 8 * 1024 * 1024;
type Config = Record<string, unknown>;

export class OpenCodeMcpError extends Error {
  constructor(
    readonly category:
      | 'configuration_failed'
      | 'unsupported_version'
      | 'not_ready'
      | 'cleanup_failed'
      | 'execution_failed',
  ) {
    // Raw subprocess/config errors can contain credentials and mock URLs.
    super(`OpenCode MCP ${category}.`);
    this.name = 'OpenCodeMcpError';
  }
}

export type OpenCodeMcpConfiguration = {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  args: ['--pure'];
  logicalNames: Record<string, string>;
  version: string;
  denials: {permission: string; pattern: string; action: 'deny'}[];
};

/**
 * Configuration preparation only; the owned runtime establishes readiness.
 * Native 1.18.26 config reads insert $schema into schema-less config files.
 * Reject those sources before starting any CLI process.
 * Returned environment/URLs are sensitive and invocation-local.
 */
export async function prepareOpenCodeMcpConfiguration(options: {
  executable: string;
  input: Pick<
    HarnessInput,
    'workDir' | 'env' | 'timeoutMs' | 'signal' | 'allowedMcpTools'
  >;
  servers: McpServerConnections;
}): Promise<OpenCodeMcpConfiguration> {
  const started = performance.now();
  const input = {
    ...options.input,
    env: {...options.input.env},
    allowedMcpTools: (options.input.allowedMcpTools ?? []).map((grant) => ({
      ...grant,
    })),
  };
  const servers = structuredClone(options.servers);
  const timeout = input.timeoutMs ?? 120_000;
  const remaining = () => {
    const value = Math.ceil(timeout - (performance.now() - started));
    if (value <= 0 || input.signal?.aborted)
      throw new OpenCodeMcpError('execution_failed');
    return value;
  };
  try {
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0
    )
      failConfig();
    const executable = await realpath(options.executable);
    const cwd = await realpath(input.workDir);
    const env = {...process.env, ...input.env};
    await checkOpenCodeConfigReads(cwd, env);
    env.OPENCODE_CONFIG_CONTENT ??= '{}';
    Object.assign(env, mcpProxyEnv(env));
    const probe = async (args: string[], childEnv = env) => {
      const result = await execa(executable, ['--pure', ...args], {
        cwd,
        env: childEnv,
        extendEnv: false,
        stdin: 'ignore',
        reject: false,
        timeout: remaining(),
        maxBuffer: OUTPUT_LIMIT,
        forceKillAfterDelay: 1000,
        ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
      });
      remaining();
      if (result.failed) failConfig();
      return result.stdout;
    };
    const version = await probe(['--version']);
    if (version.trim() !== CANDIDATE_VERSION)
      throw new OpenCodeMcpError('unsupported_version');

    // Do not use `mcp list` here: it can connect to inherited real servers.
    const initial = record(JSON.parse(await probe(['debug', 'config'])));
    const inline =
      env.OPENCODE_CONFIG_CONTENT === undefined
        ? {}
        : record(JSON.parse(env.OPENCODE_CONFIG_CONTENT));
    const {overlay, logicalNames, expected} = buildOverlay(
      initial,
      inline,
      servers,
    );
    // Preserve logical tool policy when collision-free aliases are injected.
    const permission = aliasPermissions(
      initial,
      servers,
      logicalNames,
      input.allowedMcpTools ?? [],
    );
    const launchOverlay = {...overlay, permission};
    const launchEnv = {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(launchOverlay),
    };
    const resolved = record(
      JSON.parse(await probe(['debug', 'config'], launchEnv)),
    );
    verifyResolved(resolved, expected);
    for (const [name, value] of Object.entries(permission))
      if (!isDeepStrictEqual(optionalRecord(resolved.permission)[name], value))
        failConfig();
    return {
      executable,
      cwd,
      env: launchEnv,
      args: ['--pure'],
      logicalNames,
      version: CANDIDATE_VERSION,
      denials: collectDenials(resolved),
    };
  } catch (error) {
    if (error instanceof OpenCodeMcpError) throw error;
    if (input.signal?.aborted || performance.now() - started >= timeout)
      throw new OpenCodeMcpError('execution_failed');
    failConfig();
  }
}

function collectDenials(config: Config) {
  const denials: {permission: string; pattern: string; action: 'deny'}[] = [];
  for (const source of [
    config,
    ...Object.values(optionalRecord(config.agent)).map(record),
  ]) {
    for (const [permission, value] of Object.entries(
      optionalRecord(source.permission),
    )) {
      if (value === 'deny')
        denials.push({permission, pattern: '*', action: 'deny'});
      else if (isRecord(value))
        for (const [pattern, action] of Object.entries(value))
          if (action === 'deny') denials.push({permission, pattern, action});
    }
    for (const [permission, value] of Object.entries(
      optionalRecord(source.tools),
    ))
      if (value === false)
        denials.push({permission, pattern: '*', action: 'deny'});
  }
  return denials;
}

function aliasPermissions(
  initial: Config,
  servers: McpServerConnections,
  aliases: Record<string, string>,
  grants: readonly {server: string; tool: string}[],
) {
  for (const grant of grants)
    if (!servers[grant.server]?.tools.includes(grant.tool)) failConfig();
  const permission = {...optionalRecord(initial.permission)};
  const match = (pattern: string, name: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(name);
  for (const [alias, logical] of Object.entries(aliases)) {
    if (optionalRecord(optionalRecord(initial.mcp)[logical]).enabled === false)
      throw new OpenCodeMcpError('not_ready');
    for (const tool of servers[logical]!.tools) {
      const original = `${logical.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      let policy: unknown;
      const sources = [
        initial,
        ...Object.values(optionalRecord(initial.agent)).map(record),
      ];
      for (const source of sources) {
        for (const [pattern, value] of Object.entries(
          optionalRecord(source.tools),
        ))
          if (match(pattern, original) && value === false)
            throw new OpenCodeMcpError('not_ready');
        for (const [pattern, value] of Object.entries(
          optionalRecord(source.permission),
        )) {
          if (!match(pattern, original)) continue;
          if (
            value === 'deny' ||
            (isRecord(value) && Object.values(value).includes('deny'))
          )
            throw new OpenCodeMcpError('not_ready');
          if (source === initial) policy = value;
          else if (value !== 'allow') failConfig();
        }
      }
      const name = `${alias}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      if (
        grants.some((grant) => grant.server === logical && grant.tool === tool)
      )
        policy = 'allow';
      if (policy !== undefined) permission[name] = policy;
    }
  }
  return permission;
}

/** Controller discovery/finalization remains independently required by runJob. */
export async function runOpenCodeWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = performance.now();
  const input = {
    ...options.input,
    env: {...options.input.env},
    allowedMcpTools: (options.input.allowedMcpTools ?? []).map((grant) => ({
      ...grant,
    })),
  };
  const servers = structuredClone(options.servers);
  const timeout = input.timeoutMs ?? 120_000;
  let cleanup: (() => Promise<void>) | undefined;
  const remaining = () => {
    const value = Math.ceil(timeout - (performance.now() - started));
    if (value <= 0 || input.signal?.aborted)
      throw new OpenCodeMcpError('execution_failed');
    return value;
  };
  try {
    if (options.extraArgs?.length || input.prompt.includes('\0')) failConfig();
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input,
      servers,
    });
    const password = randomBytes(24).toString('hex');
    const env = {
      ...prepared.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: 'dynobox',
    };
    const child = execa(
      prepared.executable,
      [...prepared.args, 'serve', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd: prepared.cwd,
        env,
        extendEnv: false,
        stdin: 'ignore',
        reject: false,
        timeout: remaining(),
        maxBuffer: OUTPUT_LIMIT,
        forceKillAfterDelay: 1000,
        ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
      },
    );
    cleanup = async () => {
      child.kill();
      const result = await child;
      if (result.isForcefullyTerminated)
        throw new OpenCodeMcpError('cleanup_failed');
    };
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(match[0]);
      });
      child.then(
        () => reject(new OpenCodeMcpError('execution_failed')),
        reject,
      );
    });
    const headers = {
      Authorization: `Basic ${Buffer.from(`dynobox:${password}`).toString('base64')}`,
      'x-opencode-directory': encodeURIComponent(prepared.cwd),
    };
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, {
        headers: {...headers, 'Content-Type': 'application/json'},
        redirect: 'error',
        ...(body === undefined
          ? {}
          : {method: 'POST', body: JSON.stringify(body)}),
        signal: AbortSignal.any([
          AbortSignal.timeout(remaining()),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
      if (!response.ok) throw new OpenCodeMcpError('execution_failed');
      const reader = response.body?.getReader();
      if (!reader) throw new OpenCodeMcpError('execution_failed');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > OUTPUT_LIMIT)
            throw new OpenCodeMcpError('execution_failed');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    let status = record(await request('/mcp'));
    // The pinned OpenCode runtime can report "Failed to get tools" immediately
    // after initialization without sending tools/list. Retry only discovery in
    // this same runtime, before any model invocation or tool response consumption.
    for (const name of Object.keys(prepared.logicalNames)) {
      for (
        let attempt = 0;
        attempt < 2 && record(status[name]).status === 'failed';
        attempt++
      ) {
        if (record(status[name]).error !== 'Failed to get tools') break;
        await request(`/mcp/${name}/connect`, {});
        status = record(await request('/mcp'));
      }
    }
    for (const [name, state] of Object.entries(status)) {
      if (Object.hasOwn(prepared.logicalNames, name)) {
        if (record(state).status !== 'connected')
          throw new OpenCodeMcpError('not_ready');
      } else if (record(state).status !== 'disabled') failConfig();
    }
    for (const name of Object.keys(prepared.logicalNames))
      if (!Object.hasOwn(status, name)) throw new OpenCodeMcpError('not_ready');
    const session = record(
      await request('/session', {
        ...(input.permissionMode === 'dangerous'
          ? {
              permission: [
                {permission: '*', pattern: '*', action: 'allow'},
                ...prepared.denials,
              ],
            }
          : {}),
      }),
    );
    if (
      typeof session.id !== 'string' ||
      !/^ses_[a-zA-Z0-9]+$/.test(session.id)
    )
      failConfig();
    let model;
    if (input.model !== undefined) {
      const slash = input.model.indexOf('/');
      if (slash <= 0 || slash === input.model.length - 1) failConfig();
      model = {
        providerID: input.model.slice(0, slash),
        modelID: input.model.slice(slash + 1),
      };
    }
    const completed = record(
      await request(`/session/${session.id}/message`, {
        parts: [{type: 'text', text: input.prompt}],
        ...(model ? {model} : {}),
      }),
    );
    const info = record(completed.info);
    if (info.error || info.finish !== 'stop')
      throw new OpenCodeMcpError('execution_failed');
    const messages = await request(`/session/${session.id}/message`);
    if (!Array.isArray(messages)) failConfig();
    const lines: string[] = [];
    for (const message of messages) {
      const entry = record(message);
      if (record(entry.info).role !== 'assistant') continue;
      if (!Array.isArray(entry.parts) || record(entry.info).error)
        throw new OpenCodeMcpError('execution_failed');
      for (const value of entry.parts) {
        const part = record(value);
        const type =
          part.type === 'tool'
            ? 'tool_use'
            : part.type === 'step-finish'
              ? 'step_finish'
              : part.type;
        if (['tool_use', 'text', 'step_finish'].includes(String(type)))
          lines.push(JSON.stringify({type, part}));
      }
    }
    const stdout = lines.join('\n');
    const prefixes = Object.keys(prepared.logicalNames).map(
      (name) => `${name}_`,
    );
    const parsed = parseOpenCodeJson(stdout, prefixes);
    const events = stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => record(JSON.parse(line)));
    if (
      parsed.errorMessage ||
      !events.some(
        (event) =>
          event.type === 'step_finish' && record(event.part).reason === 'stop',
      )
    )
      throw new OpenCodeMcpError('not_ready');
    const toolEvents = parsed.toolEvents.map((event) => {
      const match = Object.entries(prepared.logicalNames).find(([alias]) =>
        event.rawName.startsWith(`${alias}_`),
      );
      if (!match) return event;
      const tool = servers[match[1]]!.tools.find(
        (tool) =>
          `${match[0]}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}` ===
          event.rawName,
      );
      if (!tool) throw new OpenCodeMcpError('not_ready');
      return createToolEvent(
        `mcp__${match[1]}__${tool}`,
        event.input,
        event.status,
      );
    });
    for (const event of toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: performance.now() - started,
        metadata: {
          mcpHarnessVersion: CANDIDATE_VERSION,
          mcpRunToolEvents: toolEvents,
        },
      },
    };
  } catch (error) {
    if (error instanceof OpenCodeMcpError) throw error;
    throw new OpenCodeMcpError('execution_failed');
  } finally {
    await cleanup?.();
  }
}

function buildOverlay(
  initial: Config,
  inline: Config,
  servers: McpServerConnections,
) {
  if (!Object.keys(servers).length) failConfig();
  const inherited = optionalRecord(initial.mcp);
  const inlineMcp = optionalRecord(inline.mcp);
  const occupied = new Set([
    ...Object.keys(inherited),
    ...Object.keys(inlineMcp),
  ]);
  const occupiedToolPrefixes = new Set(
    [...occupied].map((name) => name.replace(/[^a-zA-Z0-9_-]/g, '_')),
  );
  const mcp: Config = Object.fromEntries(
    [...occupied].map((name) => [
      name,
      {...optionalRecord(inlineMcp[name]), enabled: false},
    ]),
  );
  const expected: Record<string, Config> = {};
  const logicalNames: Record<string, string> = {};
  const names = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  for (const [logical, server] of Object.entries(servers)) {
    const url = new URL(server.url);
    if (
      !names.test(logical) ||
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
      new Set(server.tools.map((tool) => tool.replace(/[^a-zA-Z0-9_-]/g, '_')))
        .size !== server.tools.length ||
      !server.tools.every((tool) => names.test(tool))
    )
      failConfig();
    let alias: string;
    do {
      alias = `dxb_${randomBytes(12).toString('hex')}`;
    } while (occupied.has(alias) || occupiedToolPrefixes.has(alias));
    occupied.add(alias);
    occupiedToolPrefixes.add(alias);
    const entry = {
      type: 'remote',
      url: server.url,
      enabled: true,
      oauth: false,
      timeout: 10_000,
    };
    mcp[alias] = entry;
    expected[alias] = entry;
    logicalNames[alias] = logical;
  }
  return {overlay: {...inline, mcp}, expected, logicalNames};
}

function verifyResolved(resolved: Config, expected: Record<string, Config>) {
  const actual = optionalRecord(resolved.mcp);
  for (const [name, value] of Object.entries(actual)) {
    const entry = record(value);
    if (Object.hasOwn(expected, name)) {
      // No inherited commands, headers, environment or OAuth credentials.
      if (!isDeepStrictEqual(entry, expected[name])) failConfig();
    } else if (entry.enabled !== false) failConfig();
  }
  for (const name of Object.keys(expected))
    if (!Object.hasOwn(actual, name)) failConfig();
}

function record(value: unknown): Config {
  if (!isRecord(value)) failConfig();
  return value;
}
function optionalRecord(value: unknown): Config {
  return value === undefined ? {} : record(value);
}
function failConfig(): never {
  throw new OpenCodeMcpError('configuration_failed');
}
