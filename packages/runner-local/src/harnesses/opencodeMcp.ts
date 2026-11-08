import {randomBytes} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {parse, type ParseError} from 'jsonc-parser';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {parseOpenCodeJson} from './opencode.js';
import {asRecord, createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

const MIN_VERSION = '2.2.5';
type Config = Record<string, unknown>;
type Rule = {action: string; resource: string; effect: string};
type Request = (path: string, body?: unknown) => Promise<unknown>;
export type OpenCodeMcpConfiguration = {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  model: ReturnType<typeof parseModel>;
  grants: Rule[];
  mockTools: Map<string, string>;
};
const toolId = (server: string, tool: string) => `${server}_${tool}`;
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

function inlineConfig(
  text: string | undefined,
  source = 'OPENCODE_CONFIG_CONTENT',
): Config {
  if (!text?.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {allowTrailingComma: true});
  if (errors.length || !isRecord(value))
    throw new McpHarnessError(
      'configuration_failed',
      `${source} must contain a JSON or JSONC object.`,
    );
  return value;
}

async function readConfig(path: string): Promise<Config> {
  try {
    return inlineConfig(await readFile(path, 'utf8'), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function serverNames(config: Config): string[] {
  const mcp = asRecord(config.mcp);
  return [
    ...new Set([
      ...Object.keys(asRecord(mcp.servers)),
      ...Object.entries(mcp)
        .filter(([, value]) => {
          const entry = asRecord(value);
          return (
            entry.type === 'local' ||
            entry.type === 'remote' ||
            typeof entry.enabled === 'boolean'
          );
        })
        .map(([name]) => name),
    ]),
  ];
}

/** Managed definitions can outrank the run overlay; preserve the existing refusal. */
async function checkManaged(
  env: NodeJS.ProcessEnv,
  servers: McpServerConnections,
) {
  const directory =
    process.platform === 'darwin'
      ? '/Library/Application Support/opencode'
      : process.platform === 'win32'
        ? join(env.ProgramData ?? 'C:\\ProgramData', 'opencode')
        : '/etc/opencode';
  if (process.platform === 'darwin') {
    for (const path of [
      join(
        '/Library/Managed Preferences',
        userInfo().username,
        'ai.opencode.managed.plist',
      ),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    ]) {
      const present = await stat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw new McpHarnessError(
            'configuration_failed',
            'Cannot inspect OpenCode managed preferences.',
          );
        },
      );
      if (present)
        throw new McpHarnessError(
          'configuration_failed',
          'OpenCode MCP mocks cannot override managed preferences on this machine.',
        );
    }
  }
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const config = await readConfig(join(directory, name));
    if (serverNames(config).some((server) => Object.hasOwn(servers, server)))
      throw new McpHarnessError(
        'configuration_failed',
        'An OpenCode mock target is provided by managed configuration and cannot be replaced.',
      );
  }
}

function parseModel(value: string | undefined) {
  if (value === undefined) return undefined;
  const [name, variant, extra] = value.split('#');
  const slash = name!.indexOf('/');
  if (
    slash <= 0 ||
    slash === name!.length - 1 ||
    variant === '' ||
    extra !== undefined
  )
    throw new McpHarnessError(
      'configuration_failed',
      `OpenCode models must be "provider/model[#variant]" (got "${value}").`,
    );
  return {
    providerID: name!.slice(0, slash),
    id: name!.slice(slash + 1),
    ...(variant === undefined ? {} : {variant}),
  };
}

/** Replace complete target entries; leave unrelated native configuration intact. */
export async function prepareOpenCodeMcpConfiguration(options: {
  executable: string;
  input: Pick<
    HarnessInput,
    'workDir' | 'env' | 'timeoutMs' | 'signal' | 'allowedMcpTools' | 'model'
  >;
  servers: McpServerConnections;
  remaining?: () => number;
}): Promise<OpenCodeMcpConfiguration> {
  const {input, servers, executable} = options;
  const remaining =
    options.remaining ?? mcpDeadline(input.timeoutMs, input.signal);
  const cwd = await realpath(input.workDir);
  const model = parseModel(input.model);
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const inline = inlineConfig(env.OPENCODE_CONFIG_CONTENT);
  await checkManaged(env, servers);
  const probe = await startOwnedProcess(executable, ['--version'], {
    cwd,
    env,
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: Math.min(5000, remaining()),
    forceKillAfterDelay: 1000,
    ...(input.signal ? {cancelSignal: input.signal} : {}),
  });
  let version: string;
  try {
    remaining();
    version = requireMcpVersion('OpenCode', MIN_VERSION, probe);
    if (!version.startsWith('2.'))
      throw new McpHarnessError(
        'unsupported_version',
        'OpenCode MCP mocking requires a supported v2 release.',
      );
  } catch (error) {
    throw new McpHarnessError(
      error instanceof McpHarnessError
        ? error.category
        : 'configuration_failed',
      error instanceof Error ? error.message : String(error),
      {
        exitCode: probe.exitCode ?? 1,
        stdout: probe.stdout,
        stderr: probe.stderr,
        durationMs: probe.durationMs,
      },
    );
  }
  const mockTools = new Map<string, string>();
  for (const [server, {tools}] of Object.entries(servers))
    for (const tool of tools) {
      const id = toolId(server, tool);
      if (mockTools.has(id))
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode mock tool name "${id}" is not unique.`,
        );
      mockTools.set(id, `mcp__${server}__${tool}`);
    }
  const grants = (input.allowedMcpTools ?? []).map(({server, tool}) => ({
    action: toolId(server, tool),
    resource: '*',
    effect: 'allow',
  }));
  return {
    executable,
    cwd,
    version,
    model,
    grants,
    mockTools,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...inline,
        mcp: {
          ...asRecord(inline.mcp),
          servers: {
            ...asRecord(asRecord(inline.mcp).servers),
            ...Object.fromEntries(
              Object.entries(servers).map(([name, server]) => [
                name,
                {
                  type: 'remote',
                  url: server.url,
                  oauth: false,
                  codemode: false,
                  timeout: {startup: 10000, catalog: 10000, execution: 10000},
                },
              ]),
            ),
          },
        },
        permissions: [
          ...(Array.isArray(inline.permissions) ? inline.permissions : []),
          ...grants,
        ],
      }),
    },
  };
}

const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) =>
        part
          .split('?')
          .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.'),
      )
      .join('.*')}$`,
  ).test(value);

/** Own startup, then let the native CLI execute the task and handle permissions. */
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
  const password = randomBytes(32).toString('hex');
  const env = {
    ...prepared.env,
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_USERNAME: 'opencode',
    OPENCODE_SERVER_USERNAME: 'opencode',
  };
  const processOptions = {
    cwd: prepared.cwd,
    env,
    extendEnv: false,
    reject: false as const,
    forceKillAfterDelay: 1000,
    ...(input.signal ? {cancelSignal: input.signal} : {}),
  };
  const server = startOwnedProcess(
    prepared.executable,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      ...processOptions,
      stdin: 'ignore',
      timeout: remaining(),
    },
  );
  let cli: ReturnType<typeof startOwnedProcess> | undefined;
  let output: HarnessRunOutput | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let text = '';
      const listening = (chunk: Buffer | string) => {
        text += String(chunk);
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+(?=\D)/);
        if (match) {
          server.stdout?.off('data', listening);
          resolve(match[0]);
        } else text = text.slice(-4096);
      };
      server.stdout?.on('data', listening);
      server.then((result) => {
        server.stdout?.off('data', listening);
        try {
          remaining();
          if (result.timedOut)
            throw new McpHarnessError(
              'timed_out',
              'MCP run exceeded its timeout.',
            );
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
    const request: Request = async (path, body) => {
      try {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
          },
          signal: AbortSignal.any([
            AbortSignal.timeout(remaining()),
            ...(input.signal ? [input.signal] : []),
          ]),
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
        if (!response.ok)
          throw new McpHarnessError(
            'execution_failed',
            `OpenCode control request returned HTTP ${response.status}.`,
          );
        if (response.status === 204) return undefined;
        return await response.json();
      } catch (error) {
        remaining();
        if (error instanceof McpHarnessError) throw error;
        throw new McpHarnessError(
          'execution_failed',
          'OpenCode returned an invalid control response.',
        );
      }
    };
    const configs = await request('/api/config');
    if (!Array.isArray(configs))
      throw new McpHarnessError(
        'configuration_failed',
        'OpenCode returned invalid configuration sources.',
      );
    const documents = configs
      .filter(isRecord)
      .filter((entry) => entry.type === 'document')
      .map((entry) => asRecord(entry.info));
    const agentId = String(
      [...documents]
        .reverse()
        .find((doc) => typeof doc.default_agent === 'string')?.default_agent ??
        'build',
    );
    let agents: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      agents = asRecord(await request('/api/agent')).data;
      if (!Array.isArray(agents) || agents.length) break;
      await delay(
        Math.min(100, remaining()),
        undefined,
        input.signal ? {signal: input.signal} : {},
      );
    }
    const agent = Array.isArray(agents)
      ? agents.find((entry) => isRecord(entry) && entry.id === agentId)
      : undefined;
    if (!isRecord(agent) || !Array.isArray(agent.permissions))
      throw new McpHarnessError(
        'configuration_failed',
        `OpenCode agent "${agentId}" is unavailable.`,
      );
    const rules = agent.permissions;
    if (
      rules.some(
        (rule) =>
          !isRecord(rule) ||
          typeof rule.action !== 'string' ||
          typeof rule.resource !== 'string' ||
          !['allow', 'ask', 'deny'].includes(String(rule.effect)),
      )
    )
      throw new McpHarnessError(
        'configuration_failed',
        'OpenCode returned invalid permission rules.',
      );
    for (const id of prepared.mockTools.keys())
      if (
        [...rules]
          .reverse()
          .find(
            (rule) => matches(rule.action, id) && matches(rule.resource, '*'),
          )?.effect === 'deny'
      )
        throw new McpHarnessError(
          'not_ready',
          `OpenCode config denies MCP tool "${id}".`,
        );
    let status: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = asRecord(await request('/api/mcp')).data;
      if (!Array.isArray(status)) break;
      const states = status;
      const pending = Object.entries(servers).some(([name, connection]) => {
        const state = states.find(
          (entry: unknown) => isRecord(entry) && entry.name === name,
        );
        const value = asRecord(asRecord(state).status).status;
        return (
          state === undefined ||
          value === 'pending' ||
          (value === 'connected' && connection.isDiscovered?.() === false)
        );
      });
      if (!pending) break;
      await delay(
        Math.min(100, remaining()),
        undefined,
        input.signal ? {signal: input.signal} : {},
      );
    }
    if (!Array.isArray(status))
      throw new McpHarnessError(
        'not_ready',
        'OpenCode returned invalid MCP status.',
      );
    const prefixes: string[] = [];
    for (const entry of status.filter(isRecord)) {
      const name = String(entry.name);
      const prefix = `${sanitize(name)}_`;
      prefixes.push(prefix);
      if (
        !Object.hasOwn(servers, name) &&
        [...prepared.mockTools.keys()].some((id) => id.startsWith(prefix))
      )
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode MCP server "${name}" overlaps a mock tool namespace. Use distinct server and tool names.`,
        );
    }
    for (const [name, connection] of Object.entries(servers)) {
      const state = status.find(
        (entry) => isRecord(entry) && entry.name === name,
      );
      if (
        asRecord(asRecord(state).status).status !== 'connected' ||
        connection.isDiscovered?.() === false
      )
        throw new McpHarnessError(
          'not_ready',
          `OpenCode did not discover MCP mock server "${name}". Check target overrides and permissions.`,
        );
    }
    // v2.2.5 connects before its separate debounced tool-registry refresh.
    await delay(
      Math.min(300, remaining()),
      undefined,
      input.signal ? {signal: input.signal} : {},
    );
    const session = asRecord(
      asRecord(
        await request('/api/session', {
          location: {directory: prepared.cwd},
          agent: agentId,
          ...(prepared.model ? {model: prepared.model} : {}),
          permissions: [
            ...prepared.grants,
            {action: 'question', resource: '*', effect: 'deny'},
          ],
        }),
      ).data,
    );
    if (typeof session.id !== 'string')
      throw new McpHarnessError(
        'execution_failed',
        'OpenCode returned an invalid session.',
      );
    cli = startOwnedProcess(
      prepared.executable,
      [
        'run',
        '--server',
        base,
        '--session',
        session.id,
        '--format',
        'json',
        ...(input.model ? ['--model', input.model] : []),
        ...(input.permissionMode === 'dangerous' ? ['--auto'] : []),
      ],
      {...processOptions, input: input.prompt, timeout: remaining()},
    );
    const completed = await cli;
    output = {
      exitCode: completed.exitCode ?? 1,
      stdout: completed.stdout,
      stderr: completed.stderr,
      durationMs: Date.now() - started,
    };
    remaining();
    if (completed.timedOut)
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    const records = jsonRecords(completed.stdout);
    if (completed.failed || records.some((record) => record.type === 'error'))
      throw new McpHarnessError(
        'execution_failed',
        'OpenCode did not complete the session successfully. See --debug for harness output.',
      );
    const finish = records
      .filter((record) => record.type === 'step_finish')
      .at(-1);
    if (asRecord(finish?.part).reason !== 'stop')
      throw new McpHarnessError(
        'execution_failed',
        'OpenCode exited without a completed assistant turn.',
      );
    records.push(...(await childToolRecords(session.id, request)));
    records.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
    for (const record of records) {
      const part = asRecord(record.part);
      const state = asRecord(part.state);
      const target =
        part.tool === 'invalid' ? asRecord(state.input).tool : undefined;
      if (typeof target === 'string' && prepared.mockTools.has(target))
        throw new McpHarnessError(
          'execution_failed',
          `OpenCode rejected arguments for MCP mock tool "${target}".`,
        );
    }
    output = {
      ...output,
      stdout: records.map((record) => JSON.stringify(record)).join('\n'),
      metadata: {opencodeMcpPrefixes: prefixes, opencodeSessionId: session.id},
    };
    const parsed = parseOpenCodeJson(output.stdout, prefixes, session.id);
    const toolEvents = parsed.toolEvents.map((event) => {
      const name = prepared.mockTools.get(event.rawName);
      return name
        ? createToolEvent(name, event.input, event.status, event.message)
        : event;
    });
    try {
      for (const event of toolEvents) input.onToolEvent?.(event);
    } catch (error) {
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode tool-event callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {harnessReady: true, version: prepared.version, toolEvents, output};
  } catch (error) {
    cli?.stop();
    server.stop();
    const [serverResult, cliResult] = await Promise.all([server, cli]);
    let failure = error;
    if (!(error instanceof McpHarnessError)) {
      try {
        remaining();
        if (serverResult.timedOut || cliResult?.timedOut)
          throw new McpHarnessError(
            'timed_out',
            'MCP run exceeded its timeout.',
          );
      } catch (deadline) {
        failure = deadline;
      }
    }
    throw new McpHarnessError(
      failure instanceof McpHarnessError
        ? failure.category
        : 'execution_failed',
      failure instanceof Error ? failure.message : String(failure),
      {
        exitCode:
          output?.exitCode ?? cliResult?.exitCode ?? serverResult.exitCode ?? 1,
        stdout: output?.stdout ?? cliResult?.stdout ?? serverResult.stdout,
        stderr: [serverResult.stderr, output?.stderr ?? cliResult?.stderr]
          .filter(Boolean)
          .join('\n'),
        durationMs: Date.now() - started,
      },
    );
  } finally {
    cli?.stop();
    server.stop();
    await Promise.all([server, cli]);
  }
}

function jsonRecords(text: string): Config[] {
  try {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) throw new Error('record');
        return value;
      });
  } catch {
    throw new McpHarnessError(
      'execution_failed',
      'OpenCode emitted invalid JSON output.',
    );
  }
}

/** The public CLI omits child tool events; retain them without replaying child text. */
async function childToolRecords(
  root: string,
  request: Request,
): Promise<Config[]> {
  const records: Config[] = [];
  const visited = new Set([root]);
  const visit = async (parent: string): Promise<void> => {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = asRecord(
        await request(
          `/api/session?parentID=${encodeURIComponent(parent)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      if (!Array.isArray(page.data) || !isRecord(page.cursor))
        throw new McpHarnessError(
          'execution_failed',
          'OpenCode returned invalid child sessions.',
        );
      for (const child of page.data) {
        if (!isRecord(child) || typeof child.id !== 'string')
          throw new McpHarnessError(
            'execution_failed',
            'OpenCode returned an invalid child session.',
          );
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        const history = asRecord(
          asRecord(
            await request(
              `/api/experimental/session/${encodeURIComponent(child.id)}/export`,
            ),
          ).data,
        );
        if (!Array.isArray(history.messages))
          throw new McpHarnessError(
            'execution_failed',
            'OpenCode returned invalid child history.',
          );
        for (const message of history.messages) {
          if (!isRecord(message))
            throw new McpHarnessError(
              'execution_failed',
              'OpenCode returned invalid child history.',
            );
          if (message.type !== 'assistant') continue;
          if (!Array.isArray(message.content))
            throw new McpHarnessError(
              'execution_failed',
              'OpenCode returned invalid child content.',
            );
          for (const content of message.content) {
            if (!isRecord(content) || content.type !== 'tool') continue;
            const state = asRecord(content.state);
            if (
              typeof content.name !== 'string' ||
              !['completed', 'error'].includes(String(state.status)) ||
              !isRecord(state.input)
            )
              throw new McpHarnessError(
                'execution_failed',
                'OpenCode returned an incomplete child tool attempt.',
              );
            records.push({
              type: 'tool_use',
              sessionID: child.id,
              timestamp:
                asRecord(content.time).ran ??
                asRecord(content.time).created ??
                asRecord(message.time).created ??
                0,
              part: {
                type: 'tool',
                id: `${child.id}:${String(message.id)}:${String(content.id)}`,
                messageID: message.id,
                tool: content.name,
                state: {
                  ...state,
                  error: isRecord(state.error)
                    ? JSON.stringify(state.error)
                    : state.error,
                },
              },
            });
          }
        }
        await visit(child.id);
      }
      const next = page.cursor.next;
      if (next !== null && typeof next !== 'string')
        throw new McpHarnessError(
          'execution_failed',
          'OpenCode returned an invalid child cursor.',
        );
      cursor = next ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new McpHarnessError(
          'execution_failed',
          'OpenCode repeated a child cursor.',
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
  };
  await visit(root);
  return records;
}
