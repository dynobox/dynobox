import {execa} from 'execa';

import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {parseOpenCodeJson} from './opencode.js';
import {createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';
import {isAtLeastVersion, parseVersion} from './version.js';

// Oldest release whose `--pure` + inline-config isolation was verified natively.
const MIN_VERSION = '1.18.26';
type Config = Record<string, unknown>;

export type OpenCodeMcpConfiguration = {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  logicalNames: Record<string, string>;
  version: string | null;
  denials: {permission: string; pattern: string; action: 'deny'}[];
};

/** OpenCode tool ids are `<server>_<tool>` with other characters replaced. */
const toolId = (server: string, tool: string) =>
  `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Build the launch environment: every inherited MCP server is disabled in an
 * inline config overlay and the mocks are added, keeping logical tool policy.
 */
export async function prepareOpenCodeMcpConfiguration(options: {
  executable: string;
  input: Pick<
    HarnessInput,
    'workDir' | 'env' | 'timeoutMs' | 'signal' | 'allowedMcpTools'
  >;
  servers: McpServerConnections;
  remaining?: () => number;
}): Promise<OpenCodeMcpConfiguration> {
  const {input, servers, executable} = options;
  const remaining =
    options.remaining ?? mcpDeadline(input.timeoutMs, input.signal);
  const cwd = input.workDir;
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const probe = async (args: string[]) => {
    const result = await execa(executable, ['--pure', ...args], {
      cwd,
      env,
      extendEnv: false,
      stdin: 'ignore',
      reject: false,
      timeout: remaining(),
      forceKillAfterDelay: 1000,
      ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
    });
    remaining();
    if (result.failed)
      throw new McpHarnessError(
        'configuration_failed',
        `opencode ${args.join(' ')} exited with code ${result.exitCode ?? 'unknown'}.`,
      );
    return result.stdout;
  };
  const version = parseVersion(await probe(['--version']));
  if (!isAtLeastVersion(version, MIN_VERSION))
    throw new McpHarnessError(
      'unsupported_version',
      `OpenCode MCP mocking requires ${MIN_VERSION} or newer (found ${version ?? 'unknown'}).`,
    );

  // Do not use `mcp list` here: it can connect to inherited real servers.
  const initial = record(JSON.parse(await probe(['debug', 'config'])));
  const inline = record(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}'));
  const occupied = new Set([
    ...Object.keys(record(initial.mcp)),
    ...Object.keys(record(inline.mcp)),
  ]);
  const mcp: Config = Object.fromEntries(
    [...occupied].map((name) => [
      name,
      {...record(record(inline.mcp)[name]), enabled: false},
    ]),
  );
  const logicalNames: Record<string, string> = {};
  const usedPrefixes = new Set([...occupied].map((name) => toolId(name, '')));
  for (const [logical, server] of Object.entries(servers)) {
    let alias = logical;
    for (let suffix = 1; usedPrefixes.has(toolId(alias, '')); suffix++)
      alias = `dynobox_${logical}_${suffix}`;
    usedPrefixes.add(toolId(alias, ''));
    mcp[alias] = {
      type: 'remote',
      url: server.url,
      enabled: true,
      oauth: false,
      timeout: 10_000,
    };
    logicalNames[alias] = logical;
  }
  const permission = aliasPermissions(
    initial,
    servers,
    logicalNames,
    input.allowedMcpTools ?? [],
  );
  const launchEnv = {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({...inline, mcp, permission}),
  };
  return {
    executable,
    cwd,
    env: launchEnv,
    logicalNames,
    version,
    denials: collectDenials(initial),
  };
}

function collectDenials(config: Config) {
  const denials: OpenCodeMcpConfiguration['denials'] = [];
  for (const source of [
    config,
    ...Object.values(record(config.agent)).map(record),
  ]) {
    for (const [permission, value] of Object.entries(
      record(source.permission),
    )) {
      if (value === 'deny')
        denials.push({permission, pattern: '*', action: 'deny'});
      else if (isRecord(value))
        for (const [pattern, action] of Object.entries(value))
          if (action === 'deny') denials.push({permission, pattern, action});
    }
    for (const [permission, value] of Object.entries(record(source.tools)))
      if (value === false)
        denials.push({permission, pattern: '*', action: 'deny'});
  }
  return denials;
}

/**
 * Carry the user's policy for logical tool ids over to aliased ids, fail when
 * a mock tool is denied (a denied tool would pass negative assertions), and
 * apply explicit `--allow-mcp-tool` grants.
 */
function aliasPermissions(
  initial: Config,
  servers: McpServerConnections,
  aliases: Record<string, string>,
  grants: readonly {server: string; tool: string}[],
) {
  const permission = {...record(initial.permission)};
  const match = (pattern: string, name: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(name);
  const sources = [
    initial,
    ...Object.values(record(initial.agent)).map(record),
  ];
  for (const [alias, logical] of Object.entries(aliases)) {
    if (record(record(initial.mcp)[logical]).enabled === false)
      throw new McpHarnessError(
        'not_ready',
        `OpenCode config disables MCP server "${logical}".`,
      );
    for (const tool of servers[logical]!.tools) {
      const original = toolId(logical, tool);
      const denied = new McpHarnessError(
        'not_ready',
        `OpenCode config denies MCP tool "${original}".`,
      );
      let policy: unknown;
      for (const source of sources) {
        for (const [pattern, value] of Object.entries(record(source.tools)))
          if (match(pattern, original) && value === false) throw denied;
        for (const [pattern, value] of Object.entries(
          record(source.permission),
        )) {
          if (!match(pattern, original)) continue;
          if (
            value === 'deny' ||
            (isRecord(value) && Object.values(value).includes('deny'))
          )
            throw denied;
          if (source === initial) policy = value;
        }
      }
      if (
        grants.some((grant) => grant.server === logical && grant.tool === tool)
      )
        policy = 'allow';
      if (policy !== undefined) permission[toolId(alias, tool)] = policy;
    }
  }
  return permission;
}

/**
 * Drive `opencode serve` so mock discovery can be confirmed (and retried)
 * before the model runs. The controller still owns discovery evidence.
 */
export async function runOpenCodeWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const {input, servers} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  if (options.extraArgs?.length)
    throw new McpHarnessError(
      'configuration_failed',
      'OpenCode MCP mocking does not support extra harness arguments.',
    );
  const prepared = await prepareOpenCodeMcpConfiguration({
    ...options,
    remaining,
  });
  const child = execa(
    prepared.executable,
    ['--pure', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: prepared.cwd,
      env: prepared.env,
      extendEnv: false,
      stdin: 'ignore',
      reject: false,
      timeout: remaining(),
      forceKillAfterDelay: 1000,
      ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
    },
  );
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(match[0]);
      });
      child.then(() => {
        try {
          remaining();
          reject(
            new McpHarnessError(
              'execution_failed',
              'opencode serve exited before listening.',
            ),
          );
        } catch (error) {
          reject(error);
        }
      }, reject);
    });
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          headers: {
            'Content-Type': 'application/json',
            'x-opencode-directory': encodeURIComponent(prepared.cwd),
          },
          ...(body === undefined
            ? {}
            : {method: 'POST', body: JSON.stringify(body)}),
          signal: AbortSignal.any([
            AbortSignal.timeout(remaining()),
            ...(input.signal ? [input.signal] : []),
          ]),
        });
      } catch (error) {
        remaining();
        throw error;
      }
      if (!response.ok)
        throw new McpHarnessError(
          'execution_failed',
          `OpenCode ${path} returned HTTP ${response.status}.`,
        );
      return response.json();
    };
    let status = record(await request('/mcp'));
    // OpenCode can report "Failed to get tools" immediately after
    // initialization without sending tools/list. Retry only discovery, before
    // any model invocation.
    for (const name of Object.keys(prepared.logicalNames)) {
      for (
        let attempt = 0;
        attempt < 2 &&
        record(status[name]).status === 'failed' &&
        record(status[name]).error === 'Failed to get tools';
        attempt++
      ) {
        await request(`/mcp/${name}/connect`, {});
        status = record(await request('/mcp'));
      }
    }
    for (const [name, state] of Object.entries(status)) {
      const current = record(state).status;
      if (Object.hasOwn(prepared.logicalNames, name)) {
        if (current !== 'connected')
          throw new McpHarnessError(
            'not_ready',
            `OpenCode reports MCP mock server "${prepared.logicalNames[name]}" as ${String(current)}.`,
          );
      } else if (current !== 'disabled')
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode left inherited MCP server "${name}" ${String(current)}.`,
        );
    }
    const missing = Object.keys(prepared.logicalNames).find(
      (name) => !Object.hasOwn(status, name),
    );
    if (missing !== undefined)
      throw new McpHarnessError(
        'not_ready',
        `OpenCode did not load MCP mock server "${prepared.logicalNames[missing]}".`,
      );
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
    let model;
    if (input.model !== undefined) {
      const slash = input.model.indexOf('/');
      if (slash <= 0)
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode models must be "provider/model" (got "${input.model}").`,
        );
      model = {
        providerID: input.model.slice(0, slash),
        modelID: input.model.slice(slash + 1),
      };
    }
    const completed = record(
      await request(`/session/${String(session.id)}/message`, {
        parts: [{type: 'text', text: input.prompt}],
        ...(model ? {model} : {}),
      }),
    );
    const info = record(completed.info);
    if (info.error || info.finish !== 'stop')
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode finished with ${info.error ? JSON.stringify(info.error) : String(info.finish)}.`,
      );
    const messages = await request(`/session/${String(session.id)}/message`);
    const lines: string[] = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const entry = record(message);
      if (record(entry.info).role !== 'assistant') continue;
      for (const value of Array.isArray(entry.parts) ? entry.parts : []) {
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
    const parsed = parseOpenCodeJson(
      stdout,
      Object.keys(prepared.logicalNames).map((name) => `${name}_`),
    );
    if (parsed.errorMessage)
      throw new McpHarnessError('execution_failed', parsed.errorMessage);
    const toolEvents = parsed.toolEvents.map((event) => {
      for (const [alias, logical] of Object.entries(prepared.logicalNames)) {
        const tool = servers[logical]!.tools.find(
          (name) => toolId(alias, name) === event.rawName,
        );
        if (tool !== undefined)
          return createToolEvent(
            `mcp__${logical}__${tool}`,
            event.input,
            event.status,
          );
      }
      return event;
    });
    for (const event of toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: Date.now() - started,
        metadata: {
          mcpHarnessVersion: prepared.version,
          mcpRunToolEvents: toolEvents,
        },
      },
    };
  } catch (error) {
    if (error instanceof McpHarnessError) throw error;
    remaining();
    throw new McpHarnessError(
      'execution_failed',
      `OpenCode MCP run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    child.kill();
    await child;
  }
}

function record(value: unknown): Config {
  return isRecord(value) ? value : {};
}
