import {randomBytes} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {homedir, userInfo} from 'node:os';
import {dirname, join, resolve} from 'node:path';
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
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

// The native regression suite uses this v2 release and its HTTP contracts.
const MIN_VERSION = '2.2.5';
type Config = Record<string, unknown>;
type Rule = {action: string; resource: string; effect: string};
export type OpenCodeMcpConfiguration = {
  executable: string;
  cwd: string;
  env: Record<string, string | undefined>;
  version: string;
};

// Mock names use the portable MCP name schema. They need no replacement.
const toolId = (server: string, tool: string) => `${server}_${tool}`;

function hasMcpServer(config: Config, name: string): boolean {
  const mcp = asRecord(config.mcp);
  const legacy = asRecord(mcp[name]);
  return (
    Object.hasOwn(asRecord(mcp.servers), name) ||
    legacy.type === 'local' ||
    legacy.type === 'remote' ||
    typeof legacy.enabled === 'boolean'
  );
}

/** Read inline configuration and report invalid JSONC as a configuration failure. */
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

function checkPolicyIsolation(
  config: Config,
  source: string,
  servers: McpServerConnections,
) {
  const policies = [
    config.policies,
    asRecord(config.experimental).policies,
  ].flatMap((value) => (Array.isArray(value) ? value : []));
  for (const policy of policies) {
    if (
      !isRecord(policy) ||
      typeof policy.action !== 'string' ||
      !['integration.use', 'plugin.use', 'mcp.use'].some((action) =>
        matches(policy.action as string, action),
      ) ||
      policy.effect !== 'allow'
    )
      continue;
    const resource = policy.resource;
    if (
      policy.action === 'integration.use' &&
      typeof resource === 'string' &&
      (resource.startsWith('skill:') ||
        Object.keys(servers).some((name) => resource === `mcp:${name}`))
    )
      continue;
    throw new McpHarnessError(
      'configuration_failed',
      `OpenCode integration allow policy in "${source}" can override MCP mock isolation. Remove that policy for this run.`,
    );
  }
}

/** Stop before launch when a file can override the blocks on inherited integrations. */
async function checkFileIsolation(
  cwd: string,
  env: NodeJS.ProcessEnv,
  servers: McpServerConnections,
) {
  const directories = new Set([
    ...(env.OPENCODE_CONFIG_DIR ? [resolve(cwd, env.OPENCODE_CONFIG_DIR)] : []),
    join(
      env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'),
      'opencode',
    ),
    ...(process.platform === 'darwin'
      ? ['/Library/Application Support/opencode']
      : process.platform === 'win32'
        ? [join(env.ProgramData ?? 'C:\\ProgramData', 'opencode')]
        : ['/etc/opencode']),
  ]);
  if (
    !['1', 'true'].includes(
      env.OPENCODE_CONFIG_PROJECT_DISABLE ??
        env.OPENCODE_DISABLE_PROJECT_CONFIG ??
        '',
    )
  ) {
    for (let directory = cwd; ; directory = dirname(directory)) {
      directories.add(directory);
      directories.add(join(directory, '.opencode'));
      if (directory === dirname(directory)) break;
    }
  }
  const files = new Set(
    [...directories].flatMap((directory) =>
      ['opencode.json', 'opencode.jsonc'].map((name) => join(directory, name)),
    ),
  );
  files.add(
    join(
      env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'),
      'opencode',
      'config.json',
    ),
  );
  if (env.OPENCODE_CONFIG) files.add(resolve(cwd, env.OPENCODE_CONFIG));
  if (process.platform === 'darwin') {
    // Managed preferences are authoritative and cannot be replaced by this overlay.
    for (const file of [
      join(
        '/Library/Managed Preferences',
        userInfo().username,
        'ai.opencode.managed.plist',
      ),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    ]) {
      const present = await readFile(file).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (present)
        throw new McpHarnessError(
          'configuration_failed',
          'OpenCode MCP mocking cannot isolate managed preferences on this machine.',
        );
    }
  }
  await Promise.all(
    [...files].map(async (file) => {
      const text = await readFile(file, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw new McpHarnessError(
            'configuration_failed',
            `Cannot read OpenCode configuration "${file}".`,
          );
        },
      );
      if (text === undefined) return;
      const config = inlineConfig(text, file);
      for (const name of Object.keys(servers))
        if (hasMcpServer(config, name))
          throw new McpHarnessError(
            'configuration_failed',
            `OpenCode config already has an MCP server named "${name}"; rename or remove it to use this mock.`,
          );
      checkPolicyIsolation(config, file, servers);
    }),
  );
}

function parseModel(value: string | undefined) {
  let model: {providerID: string; id: string; variant?: string} | undefined;
  if (value !== undefined) {
    const [modelName, variant, extra] = value.split('#');
    const slash = modelName!.indexOf('/');
    if (
      slash <= 0 ||
      slash === modelName!.length - 1 ||
      variant === '' ||
      extra !== undefined
    )
      throw new McpHarnessError(
        'configuration_failed',
        `OpenCode models must be "provider/model[#variant]" (got "${value}").`,
      );
    model = {
      providerID: modelName!.slice(0, slash),
      id: modelName!.slice(slash + 1),
      ...(variant === undefined ? {} : {variant}),
    };
  }
  return model;
}

/** Prepare a v2 launch with mock connections and blocks for inherited integrations. */
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
  parseModel(input.model);
  const cwd = await realpath(input.workDir);
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const inline = inlineConfig(env.OPENCODE_CONFIG_CONTENT);
  checkPolicyIsolation(inline, 'OPENCODE_CONFIG_CONTENT', servers);
  await checkFileIsolation(cwd, env, servers);
  for (const name of Object.keys(servers))
    if (hasMcpServer(inline, name))
      throw new McpHarnessError(
        'configuration_failed',
        `OpenCode inline config already has an MCP server named "${name}".`,
      );
  const result = await startOwnedProcess(executable, ['--version'], {
    cwd,
    env,
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: Math.min(5000, remaining()),
    forceKillAfterDelay: 1000,
    ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
  });
  let version: string;
  try {
    remaining();
    version = requireMcpVersion('OpenCode', MIN_VERSION, result);
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
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    );
  }
  const names = new Set<string>();
  for (const [server, {tools}] of Object.entries(servers))
    for (const tool of tools) {
      const id = toolId(server, tool);
      if (names.has(id))
        throw new McpHarnessError(
          'configuration_failed',
          `OpenCode mock tool name "${id}" is not unique.`,
        );
      names.add(id);
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
                  timeout: {
                    startup: 10_000,
                    catalog: 10_000,
                    execution: 10_000,
                  },
                },
              ]),
            ),
          },
        },
        permissions: [
          ...(Array.isArray(inline.permissions) ? inline.permissions : []),
          ...grants,
        ],
        policies: [
          ...(Array.isArray(inline.policies) ? inline.policies : []),
          {action: 'integration.use', resource: 'mcp:*', effect: 'deny'},
          ...Object.keys(servers).map((name) => ({
            action: 'integration.use',
            resource: `mcp:${name}`,
            effect: 'allow',
          })),
          {action: 'integration.use', resource: 'plugin:*', effect: 'deny'},
        ],
      }),
    },
  };
}

/** Match a tool name against an OpenCode permission pattern. */
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

/** Run one v2 session and retain the received tool inputs and failure reasons. */
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
  const child = startOwnedProcess(
    prepared.executable,
    ['serve', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: prepared.cwd,
      env: {
        ...prepared.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
      },
      extendEnv: false,
      stdin: 'ignore',
      reject: false,
      timeout: remaining(),
      forceKillAfterDelay: 1000,
      ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
    },
  );
  let transcript: string | undefined;
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = '';
      const listening = (chunk: Buffer) => {
        output += chunk.toString();
        // Wait for whitespace after the port. End-of-chunk is not end-of-port.
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)(?=\s)/);
        if (match) {
          child.stdout?.off('data', listening);
          resolve(match[0]);
        } else output = output.slice(-4096);
      };
      child.stdout?.on('data', listening);
      child.then((result) => {
        child.stdout?.off('data', listening);
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
    /**
     * Send a v2 control request within the remaining job time.
     * Use node:http to avoid the fetch header timeout during a model turn.
     */
    const request = async (
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const deadline = AbortSignal.timeout(remaining());
      const {status, text} = await new Promise<{status: number; text: string}>(
        (resolve, reject) => {
          const outgoing = httpRequest(
            `${base}${path}`,
            {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
              },
              signal: AbortSignal.any([
                deadline,
                ...(input.signal ? [input.signal] : []),
                ...(signal ? [signal] : []),
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
        if (deadline.aborted)
          throw new McpHarnessError(
            'timed_out',
            'MCP run exceeded its timeout.',
          );
        throw error;
      });
      if (status < 200 || status >= 300)
        throw new McpHarnessError(
          'execution_failed',
          `OpenCode ${path} returned HTTP ${status}.`,
        );
      if (status === 204) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new McpHarnessError(
          'execution_failed',
          `OpenCode ${path} returned invalid JSON.`,
        );
      }
    };
    const entries = await request('/api/config');
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !isRecord(entry) ||
          !['document', 'directory'].includes(String(entry.type)) ||
          (entry.type === 'document' && !isRecord(entry.info)),
      )
    )
      throw new McpHarnessError(
        'configuration_failed',
        'OpenCode returned invalid configuration sources.',
      );
    const documents = entries
      .filter((entry) => entry.type === 'document')
      .map((entry) => asRecord(entry.info));
    const agentId = String(
      [...documents]
        .reverse()
        .find((doc) => typeof doc.default_agent === 'string')?.default_agent ??
        'build',
    );
    let agents: unknown = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      agents = asRecord(await request('/api/agent')).data;
      if (!Array.isArray(agents) || agents.length > 0) break;
      await delay(
        Math.min(100, remaining()),
        undefined,
        input.signal ? {signal: input.signal} : {},
      );
    }
    if (!Array.isArray(agents))
      throw new McpHarnessError(
        'configuration_failed',
        'OpenCode returned invalid agents.',
      );
    const agent = agents.find(
      (value) => isRecord(value) && value.id === agentId,
    );
    if (!isRecord(agent) || !Array.isArray(agent.permissions))
      throw new McpHarnessError(
        'configuration_failed',
        `OpenCode agent "${agentId}" is not available.`,
      );
    const rules = agent.permissions as Rule[];
    if (
      rules.some(
        (rule) =>
          !isRecord(rule) ||
          typeof rule.action !== 'string' ||
          typeof rule.resource !== 'string' ||
          !['allow', 'ask', 'deny'].includes(rule.effect),
      )
    )
      throw new McpHarnessError(
        'configuration_failed',
        'OpenCode returned invalid permission rules.',
      );
    for (const [server, {tools}] of Object.entries(servers))
      for (const tool of tools) {
        const id = toolId(server, tool);
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
      }
    let status: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = asRecord(await request('/api/mcp')).data;
      if (!Array.isArray(status)) break;
      const states = status;
      const pending = Object.keys(servers).some((name) => {
        const value = states.find(
          (value: unknown) => isRecord(value) && value.name === name,
        );
        return (
          value === undefined ||
          asRecord(asRecord(value).status).status === 'pending'
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
    for (const value of status) {
      const state = asRecord(value);
      if (!Object.hasOwn(servers, String(state.name))) {
        if (asRecord(state.status).status !== 'disabled')
          throw new McpHarnessError(
            'configuration_failed',
            `OpenCode did not block inherited MCP server "${String(state.name)}".`,
          );
      }
    }
    for (const name of Object.keys(servers)) {
      const state = status.find(
        (value) => isRecord(value) && value.name === name,
      );
      if (asRecord(asRecord(state).status).status !== 'connected')
        throw new McpHarnessError(
          'not_ready',
          `OpenCode MCP mock server "${name}" is not connected.`,
        );
    }
    // v2 debounces tool registration for 100 ms after discovery. A connected
    // transport can still have an empty model tool catalog during that window.
    await delay(
      Math.min(200, remaining()),
      undefined,
      input.signal ? {signal: input.signal} : {},
    );
    const grants = (input.allowedMcpTools ?? []).map(({server, tool}) => ({
      action: toolId(server, tool),
      resource: '*',
      effect: 'allow',
    }));
    const model = parseModel(input.model);
    const session = asRecord(
      asRecord(
        await request('/api/session', {
          location: {directory: prepared.cwd},
          agent: agentId,
          ...(model ? {model} : {}),
          permissions: [
            ...(input.permissionMode === 'dangerous'
              ? [
                  {action: '*', resource: '*', effect: 'allow'},
                  ...rules.map((rule) => ({
                    ...rule,
                    effect: rule.effect === 'ask' ? 'allow' : rule.effect,
                  })),
                ]
              : []),
            ...grants,
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
    const encodedSessionId = encodeURIComponent(session.id);
    const permissions = new AbortController();
    const rejected = new Set<string>();
    /** Answer permission requests until the model turn ends. */
    const answerPermissions = (async () => {
      while (!permissions.signal.aborted) {
        const pending = asRecord(
          await request(
            '/api/permission/request',
            undefined,
            permissions.signal,
          ),
        ).data;
        if (!Array.isArray(pending))
          throw new McpHarnessError(
            'execution_failed',
            'OpenCode returned invalid permission requests.',
          );
        for (const value of pending) {
          if (permissions.signal.aborted) return;
          const permission = asRecord(value);
          if (
            typeof permission.id !== 'string' ||
            typeof permission.sessionID !== 'string' ||
            typeof permission.action !== 'string'
          )
            throw new McpHarnessError(
              'execution_failed',
              'OpenCode returned an invalid permission request.',
            );
          const approve = input.permissionMode === 'dangerous';
          if (!approve) rejected.add(String(permission.action));
          await request(
            `/api/session/${encodeURIComponent(String(permission.sessionID))}/permission/${encodeURIComponent(String(permission.id))}/reply`,
            {
              decision: approve ? 'once' : 'reject',
              ...(!approve
                ? {
                    message:
                      'This non-interactive run cannot approve this action. Continue without it.',
                  }
                : {}),
            },
            permissions.signal,
          );
        }
        await delay(200, undefined, {signal: permissions.signal});
      }
    })();
    // Race failures from either task. Abort the other task when this turn ends.
    try {
      await Promise.race([
        (async () => {
          await request(
            `/api/session/${encodedSessionId}/prompt`,
            {text: input.prompt},
            permissions.signal,
          );
          await request(
            `/api/experimental/session/${encodedSessionId}/wait`,
            {},
            permissions.signal,
          );
        })(),
        answerPermissions,
      ]);
    } finally {
      permissions.abort();
      await answerPermissions.catch(() => {});
    }
    const exported = asRecord(
      asRecord(
        await request(`/api/experimental/session/${encodedSessionId}/export`),
      ).data,
    );
    const histories = [messageHistoryTranscript(exported.messages, servers)];
    const visited = new Set<string>([session.id]);
    const collectChildren = async (id: string): Promise<void> => {
      const children: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = asRecord(
          await request(
            `/api/session?parentID=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ),
        );
        if (!Array.isArray(page.data) || !isRecord(page.cursor))
          throw new McpHarnessError(
            'execution_failed',
            'OpenCode returned invalid child sessions.',
          );
        children.push(...page.data);
        const next = page.cursor.next;
        if (next !== null && typeof next !== 'string')
          throw new McpHarnessError(
            'execution_failed',
            'OpenCode returned an invalid session cursor.',
          );
        cursor = next ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor))
            throw new McpHarnessError(
              'execution_failed',
              'OpenCode repeated a session cursor.',
            );
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      for (const child of children) {
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
        histories.push(messageHistoryTranscript(history.messages, servers));
        await collectChildren(child.id);
      }
    };
    await collectChildren(session.id);
    // Keep the primary session last so its final answer remains the run result.
    transcript = [...histories.slice(1), histories[0]].join('\n');
    if (
      [...rejected].some((id) =>
        Object.entries(servers).some(([server, {tools}]) =>
          tools.some((tool) => toolId(server, tool) === id),
        ),
      )
    )
      throw new McpHarnessError(
        'execution_failed',
        'OpenCode rejected permission for a mock tool. Allow the tool in the OpenCode configuration.',
      );
    if (asRecord(exported.info).outcome !== 'succeeded')
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode session ${String(asRecord(exported.info).outcome)}.`,
      );
    const parsed = parseOpenCodeJson(transcript);
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
            event.message,
          );
      }
      return event;
    });
    try {
      for (const event of toolEvents) input.onToolEvent?.(event);
    } catch (error) {
      throw new McpHarnessError(
        'execution_failed',
        `OpenCode tool-event callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      harnessReady: true,
      version: prepared.version,
      toolEvents,
      output: {
        exitCode: 0,
        stdout: transcript,
        stderr: '',
        durationMs: Date.now() - started,
      },
    };
  } catch (error) {
    child.stop();
    const result = await child;
    let failure = error;
    if (!(error instanceof McpHarnessError)) {
      try {
        remaining();
        if (result.timedOut)
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
        exitCode: result.exitCode ?? 1,
        stdout: transcript ?? result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      },
    );
  } finally {
    child.stop();
    await child;
  }
}

/** Validate the complete v2 history and convert assistant content to parser events. */
function messageHistoryTranscript(
  messages: unknown,
  servers: McpServerConnections,
): string {
  const invalid = () =>
    new McpHarnessError(
      'execution_failed',
      'OpenCode returned invalid message history.',
    );
  if (!Array.isArray(messages)) throw invalid();
  const lines: string[] = [];
  let lastFinish: unknown;
  let lastError: unknown;
  for (const message of messages) {
    if (
      !isRecord(message) ||
      typeof message.type !== 'string' ||
      typeof message.id !== 'string'
    )
      throw invalid();
    if (message.type !== 'assistant') continue;
    if (!Array.isArray(message.content)) throw invalid();
    lastError = message.error;
    if (message.error)
      lines.push(
        JSON.stringify({
          type: 'text',
          part: {
            type: 'text',
            id: `${message.id}:error`,
            messageID: message.id,
            text: `OpenCode assistant error: ${JSON.stringify(message.error)}`,
          },
        }),
      );
    lastFinish = message.finish;
    for (const [index, content] of message.content.entries()) {
      if (!isRecord(content) || typeof content.type !== 'string')
        throw invalid();
      if (content.type === 'text') {
        if (typeof content.text !== 'string') throw invalid();
        lines.push(
          JSON.stringify({
            type: 'text',
            part: {
              type: 'text',
              id: `${message.id}:${index}`,
              messageID: message.id,
              text: content.text,
            },
          }),
        );
      } else if (content.type === 'tool') {
        if (
          typeof content.name !== 'string' ||
          typeof content.id !== 'string' ||
          !isRecord(content.state) ||
          !['completed', 'error'].includes(String(content.state.status)) ||
          !isRecord(content.state.input)
        )
          throw invalid();
        const target =
          content.name === 'invalid' ? content.state.input.tool : undefined;
        if (
          typeof target === 'string' &&
          Object.entries(servers).some(([server, {tools}]) =>
            tools.some((tool) => toolId(server, tool) === target),
          )
        )
          throw new McpHarnessError(
            'execution_failed',
            `OpenCode rejected arguments for mock tool "${target}" before it reached the mock.`,
          );
        const state = {
          ...content.state,
          error: isRecord(content.state.error)
            ? JSON.stringify(content.state.error)
            : content.state.error,
        };
        lines.push(
          JSON.stringify({
            type: 'tool_use',
            part: {
              type: 'tool',
              id: `${message.id}:${content.id}`,
              tool: content.name,
              state,
            },
          }),
        );
      }
    }
  }
  if (lastError)
    throw new McpHarnessError(
      'execution_failed',
      `OpenCode assistant failed: ${JSON.stringify(lastError)}`,
    );
  if (lastFinish !== 'stop')
    throw new McpHarnessError(
      'execution_failed',
      `OpenCode finished with ${String(lastFinish)}.`,
    );
  return lines.join('\n');
}
