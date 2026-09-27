import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

import {execa} from 'execa';

import {mcpDeadline, McpHarnessError, requireMcpVersion} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {parseOpenCodeJson} from './opencode.js';
import {asRecord, createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

// Oldest release whose `--pure` + inline-config isolation was verified natively.
const MIN_VERSION = '1.18.26';
type Config = Record<string, unknown>;

export type OpenCodeMcpConfiguration = {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  version: string | null;
  denials: {permission: string; pattern: string; action: string}[];
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
  const version = requireMcpVersion('OpenCode', MIN_VERSION, {
    failed: false,
    stdout: await probe(['--version']),
  });

  // Do not use `mcp list` here: it can connect to inherited real servers.
  const initial = asRecord(JSON.parse(await probe(['debug', 'config'])));
  const inline = asRecord(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}'));
  const occupied = new Set([
    ...Object.keys(asRecord(initial.mcp)),
    ...Object.keys(asRecord(inline.mcp)),
  ]);
  const mcp: Config = Object.fromEntries(
    [...occupied].map((name) => [
      name,
      {...asRecord(asRecord(inline.mcp)[name]), enabled: false},
    ]),
  );
  const usedPrefixes = new Set([...occupied].map((name) => toolId(name, '')));
  const mockTools = new Map<string, string>();
  for (const [name, {tools}] of Object.entries(servers))
    for (const tool of tools) {
      const id = toolId(name, tool);
      const other = mockTools.get(id);
      if (other !== undefined)
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode names both mcp__${other} and mcp__${name}__${tool} "${id}"; rename one to use these mocks.`,
        );
      mockTools.set(id, `${name}__${tool}`);
    }
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
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inline,
      mcp,
      // `opencode serve` offers a question tool that `opencode run` does not;
      // an unanswered question would stall the run.
      permission: {...permission, question: 'deny'},
    }),
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
    asRecord(asRecord(config.agent)[String(config.default_agent ?? 'build')]),
  ]) {
    for (const [permission, value] of Object.entries(asRecord(source.tools)))
      if (value === false)
        denials.push({permission, pattern: '*', action: 'deny'});
    for (const [permission, value] of Object.entries(
      asRecord(source.permission),
    )) {
      if (typeof value === 'string')
        denials.push({permission, pattern: '*', action: value});
      else if (isRecord(value))
        for (const [pattern, action] of Object.entries(value))
          if (typeof action === 'string')
            denials.push({permission, pattern, action});
    }
  }
  return denials;
}

/**
 * Fail when a mock tool is denied (a denied tool would pass negative
 * assertions) and apply grants for declared mock tools.
 */
function mockPermissions(
  initial: Config,
  servers: McpServerConnections,
  grants: readonly {server: string; tool: string}[],
) {
  const permission = {...asRecord(initial.permission)};
  const match = (pattern: string, name: string) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(name);
  const selectedAgent = asRecord(
    asRecord(initial.agent)[String(initial.default_agent ?? 'build')],
  );
  for (const [server, {tools}] of Object.entries(servers)) {
    for (const tool of tools) {
      const id = toolId(server, tool);
      const denied = new McpHarnessError(
        'not_ready',
        `OpenCode config denies MCP tool "${id}".`,
      );
      const granted = grants.some(
        (grant) => grant.server === server && grant.tool === tool,
      );
      let action: string | undefined;
      for (const [index, source] of [initial, selectedAgent].entries()) {
        if (index === 1 && granted) action = 'allow';
        for (const [pattern, value] of Object.entries(asRecord(source.tools)))
          if (match(pattern, id) && value === false) action = 'deny';
        for (const [pattern, value] of Object.entries(
          asRecord(source.permission),
        )) {
          if (!match(pattern, id)) continue;
          if (typeof value === 'string') action = value;
          else if (isRecord(value))
            for (const [nestedPattern, nestedAction] of Object.entries(value))
              if (match(nestedPattern, id) && typeof nestedAction === 'string')
                action = nestedAction;
        }
      }
      if (action === 'deny') throw denied;
      if (granted) permission[id] = 'allow';
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
}): Promise<McpHarnessRun> {
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
  // The adapter's own requests carry no credentials, and `opencode run` never
  // needed them, so this private server runs without basic auth.
  const {
    OPENCODE_SERVER_PASSWORD: _password,
    OPENCODE_SERVER_USERNAME: _username,
    ...serveEnv
  } = prepared.env;
  const child = execa(
    prepared.executable,
    ['--pure', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: prepared.cwd,
      env: serveEnv,
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
    // node:http rather than fetch: fetch caps a response at 300s, and the
    // message request stays open for the whole model turn.
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const {status, text} = await new Promise<{status: number; text: string}>(
        (resolve, reject) => {
          const outgoing = httpRequest(
            `${base}${path}`,
            {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-opencode-directory': encodeURIComponent(prepared.cwd),
              },
              signal: AbortSignal.any([
                AbortSignal.timeout(remaining()),
                ...(input.signal ? [input.signal] : []),
              ]),
            },
            (response) => {
              let text = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => (text += chunk));
              response.on('end', () =>
                resolve({status: response.statusCode ?? 0, text}),
              );
              response.on('error', reject);
            },
          );
          outgoing.on('error', reject);
          outgoing.end(body === undefined ? undefined : JSON.stringify(body));
        },
      ).catch((error: unknown) => {
        remaining();
        throw error;
      });
      if (status < 200 || status >= 300)
        throw new McpHarnessError(
          'execution_failed',
          `OpenCode ${path} returned HTTP ${status}.`,
        );
      return JSON.parse(text);
    };
    let status = asRecord(await request('/mcp'));
    // OpenCode can report "Failed to get tools" immediately after
    // initialization without sending tools/list. Retry only discovery, before
    // any model invocation.
    for (const name of Object.keys(servers)) {
      for (
        let attempt = 0;
        attempt < 2 &&
        asRecord(status[name]).status === 'failed' &&
        asRecord(status[name]).error === 'Failed to get tools';
        attempt++
      ) {
        await request(`/mcp/${name}/connect`, {});
        status = asRecord(await request('/mcp'));
      }
    }
    for (const [name, state] of Object.entries(status)) {
      const current = asRecord(state).status;
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
    const session = asRecord(
      await request('/session', {
        ...(input.permissionMode === 'dangerous'
          ? {
              permission: [
                {permission: '*', pattern: '*', action: 'allow'},
                ...prepared.denials,
                ...(input.allowedMcpTools ?? []).map(({server, tool}) => ({
                  permission: toolId(server, tool),
                  pattern: '*',
                  action: 'allow',
                })),
                {permission: 'question', pattern: '*', action: 'deny'},
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
          const permission = asRecord(value);
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
      completed = asRecord(
        await request(`/session/${String(session.id)}/message`, {
          parts: [{type: 'text', text: input.prompt}],
          ...(model ? {model} : {}),
        }),
      );
    } finally {
      prompting = false;
      await rejectPermissions;
    }
    const info = asRecord(completed.info);
    // A rejected mock call never reaches the mock, so it would otherwise let
    // a negative assertion pass. Other rejections end the turn early.
    const mockIds = new Set(
      Object.entries(servers).flatMap(([server, {tools}]) =>
        tools.map((tool) => toolId(server, tool)),
      ),
    );
    if (
      rejected.size > 0 &&
      (info.finish !== 'stop' || [...rejected].some((id) => mockIds.has(id)))
    )
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode rejected an "ask" permission for ${[...rejected].join(', ')}. Check the OpenCode permission settings.`,
      );
    if (info.error || info.finish !== 'stop')
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode finished with ${info.error ? JSON.stringify(info.error) : String(info.finish)}.`,
      );
    const messages = await request(`/session/${String(session.id)}/message`);
    const lines: string[] = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const entry = asRecord(message);
      if (asRecord(entry.info).role !== 'assistant') continue;
      for (const value of Array.isArray(entry.parts) ? entry.parts : []) {
        const part = asRecord(value);
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
      version: prepared.version,
      toolEvents,
      output: {
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: Date.now() - started,
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
