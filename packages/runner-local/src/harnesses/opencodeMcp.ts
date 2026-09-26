import {setTimeout as delay} from 'node:timers/promises';

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
  version: string | null;
  denials: {permission: string; pattern: string; action: 'deny'}[];
};

/** OpenCode tool ids are `<server>_<tool>` with other characters replaced. */
const toolId = (server: string, tool: string) =>
  `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Build the launch environment: every inherited MCP server is disabled in an
 * inline config overlay and the mocks are added under their own names.
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
  const usedPrefixes = new Set([...occupied].map((name) => toolId(name, '')));
  for (const [name, server] of Object.entries(servers)) {
    // Renaming the mock would show the model a different tool name than
    // other harnesses, so a name clash fails instead.
    if (usedPrefixes.has(toolId(name, '')))
      throw new McpHarnessError(
        'configuration_failed',
        `OpenCode config already has an MCP server named "${name}"; rename or remove it to use this mock.`,
      );
    mcp[name] = {
      type: 'remote',
      url: server.url,
      enabled: true,
      oauth: false,
      timeout: 10_000,
    };
  }
  const permission = mockPermissions(
    initial,
    servers,
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
 * Fail when a mock tool is denied (a denied tool would pass negative
 * assertions) and apply explicit `--allow-mcp-tool` grants.
 */
function mockPermissions(
  initial: Config,
  servers: McpServerConnections,
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
  for (const [server, {tools}] of Object.entries(servers)) {
    for (const tool of tools) {
      const id = toolId(server, tool);
      const denied = new McpHarnessError(
        'not_ready',
        `OpenCode config denies MCP tool "${id}".`,
      );
      for (const source of sources) {
        for (const [pattern, value] of Object.entries(record(source.tools)))
          if (match(pattern, id) && value === false) throw denied;
        for (const [pattern, value] of Object.entries(
          record(source.permission),
        ))
          if (
            match(pattern, id) &&
            (value === 'deny' ||
              (isRecord(value) && Object.values(value).includes('deny')))
          )
            throw denied;
      }
      if (
        grants.some((grant) => grant.server === server && grant.tool === tool)
      )
        permission[id] = 'allow';
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
    for (const name of Object.keys(servers)) {
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
      if (Object.hasOwn(servers, name)) {
        if (current !== 'connected')
          throw new McpHarnessError(
            'not_ready',
            `OpenCode reports MCP mock server "${name}" as ${String(current)}.`,
          );
      } else if (current !== 'disabled')
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode left inherited MCP server "${name}" ${String(current)}.`,
        );
    }
    const missing = Object.keys(servers).find(
      (name) => !Object.hasOwn(status, name),
    );
    if (missing !== undefined)
      throw new McpHarnessError(
        'not_ready',
        `OpenCode did not load MCP mock server "${missing}".`,
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
    // `opencode run` auto-rejects permission requests, but serve waits for a
    // reply. Reject them the same way so an `ask` rule cannot stall the run.
    let prompting = true;
    const rejected = new Set<string>();
    const rejectPermissions = (async () => {
      while (prompting) {
        const pending = await request('/permission').catch(() => []);
        for (const value of Array.isArray(pending) ? pending : []) {
          const permission = record(value);
          rejected.add(String(permission.permission));
          await request(`/permission/${String(permission.id)}/reply`, {
            reply: 'reject',
          }).catch(() => {});
        }
        await delay(200);
      }
    })();
    let completed: Config;
    try {
      completed = record(
        await request(`/session/${String(session.id)}/message`, {
          parts: [{type: 'text', text: input.prompt}],
          ...(model ? {model} : {}),
        }),
      );
    } finally {
      prompting = false;
      await rejectPermissions;
    }
    const info = record(completed.info);
    // A rejected permission ends the OpenCode turn early.
    if (rejected.size > 0 && info.finish !== 'stop')
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode stopped after it rejected an "ask" permission for ${[...rejected].join(', ')}. Use --allow-mcp-tool for mock tools, or allow the tool in the OpenCode config.`,
      );
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
      Object.keys(servers).map((name) => `${name}_`),
    );
    if (parsed.errorMessage)
      throw new McpHarnessError('execution_failed', parsed.errorMessage);
    const toolEvents = parsed.toolEvents.map((event) => {
      for (const [server, {tools}] of Object.entries(servers)) {
        const tool = tools.find(
          (name) => toolId(server, name) === event.rawName,
        );
        if (tool !== undefined)
          return createToolEvent(
            `mcp__${server}__${tool}`,
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
