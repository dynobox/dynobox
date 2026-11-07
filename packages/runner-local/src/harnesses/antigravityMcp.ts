import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {parse, type ParseError} from 'jsonc-parser';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {
  createAntigravityAcpParser,
  parseAntigravityJson,
} from './antigravity.js';
import {
  asRecord,
  createToolEvent,
  isRecord,
  type JsonObject,
} from './parsing.js';
import {lineSplitter} from './runStreamingHarness.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpInventory,
  McpServerConnections,
  ToolEvent,
} from './types.js';

// ACP HTTP sessions and the configuration directory flag verified natively.
const MIN_VERSION = '1.5.2';
const CONFIG_FLAGS = new Set([
  '--gemini-dir',
  '--gemini_dir',
  '--app-data-dir',
  '--app_data_dir',
  '--cli_dir_name',
  '--include-default-customizations',
  '--worker',
  '--project',
  '--new-project',
  '--agent',
  '--continue',
  '-c',
  '--conversation',
  '--settings',
  '--model',
  '--effort',
  '--mode',
  '--print',
  '-p',
  '--input-format',
  '--output-format',
  '--print-timeout',
  '--',
]);

// Native tool-schema files are keyed by server name in the normal CLI data
// directory. Keep Dynobox runs sharing that directory from racing each other.
const turns = new Map<string, Promise<void>>();

async function inTurn<T>(
  home: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = turns.get(home) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  // A cancelled waiter releases at once, but later runs still wait for the
  // runs ahead of it.
  const tail = previous.then(() => current);
  turns.set(home, tail);
  // Forget the HOME only once every run queued so far has finished.
  void tail.then(() => {
    if (turns.get(home) === tail) turns.delete(home);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () =>
        reject(
          new McpHarnessError('execution_failed', 'MCP run was cancelled.'),
        );
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, {once: true});
      void previous.then(() => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      });
    });
    return await run();
  } finally {
    release();
  }
}

export function logicalMcpToolEvents(
  events: readonly ToolEvent[],
  servers: McpServerConnections,
): ToolEvent[] {
  return events.map((event) => {
    if (event.rawName !== 'call_mcp_tool' || !isRecord(event.input))
      return event;
    const {ServerName: server, ToolName: tool, Arguments: args} = event.input;
    if (
      typeof server !== 'string' ||
      typeof tool !== 'string' ||
      !Object.hasOwn(servers, server) ||
      !servers[server]!.tools.includes(tool)
    )
      return event;
    return createToolEvent(
      `mcp__${server}__${tool}`,
      args ?? {},
      event.status,
      event.message,
    );
  });
}

function configPath(home: string): string {
  return join(home, '.gemini', 'config', 'mcp_config.json');
}
async function readConfig(path: string): Promise<JsonObject> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new McpHarnessError(
      'configuration_failed',
      'Cannot read Antigravity MCP configuration.',
    );
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, {allowTrailingComma: true});
  if (
    errors.length ||
    !isRecord(value) ||
    (value.mcpServers !== undefined && !isRecord(value.mcpServers))
  )
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP configuration must contain a valid mcpServers object.',
    );
  return value;
}

/** Passive profile inventory; workspace, plugin, and managed sources may add MCPs. */
export async function inspectAntigravityMcp(
  input: Pick<HarnessInput, 'env'>,
): Promise<McpInventory> {
  const home = input.env.HOME ?? process.env.HOME ?? homedir();
  return {
    servers: Object.keys(
      asRecord((await readConfig(configPath(home))).mcpServers),
    ),
    complete: false,
  };
}

/** Keep the original directory layout and native login paths; own only MCP config. */
async function createConfigView(
  home: string,
  servers: McpServerConnections,
): Promise<string> {
  const config = await readConfig(configPath(home));
  const definitions = {...asRecord(config.mcpServers)};
  for (const [name, server] of Object.entries(servers)) {
    if (asRecord(definitions[name]).command !== undefined)
      throw new McpHarnessError(
        'configuration_failed',
        `Antigravity MCP target "${name}" uses stdio; selective mocking supports HTTP targets.`,
      );
    definitions[name] = {serverUrl: server.url};
  }
  // A sibling of .gemini preserves relative paths escaping its config directory.
  // HOME and the complete native CLI data directory stay unchanged.
  const view = await mkdtemp(join(home, '.dynobox-agy-mcp-'));
  const linkEntries = async (source: string, target: string, skip: string) => {
    await mkdir(target, {recursive: true});
    const names = await readdir(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const name of names)
      if (name !== skip) await symlink(join(source, name), join(target, name));
  };
  try {
    await linkEntries(join(home, '.gemini'), view, 'config');
    await linkEntries(
      join(home, '.gemini', 'config'),
      join(view, 'config'),
      'mcp_config.json',
    );
    await writeFile(
      join(view, 'config', 'mcp_config.json'),
      JSON.stringify({...config, mcpServers: definitions}),
      {mode: 0o600},
    );
    return view;
  } catch (error) {
    await rm(view, {recursive: true, force: true});
    throw error;
  }
}

export async function runAntigravityWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<McpHarnessRun> {
  const {input, servers, executable} = options;
  for (const arg of options.extraArgs ?? []) {
    const flag = arg.split('=')[0]!;
    if (CONFIG_FLAGS.has(flag))
      throw new McpHarnessError(
        'configuration_failed',
        `Antigravity extra argument ${flag} conflicts with MCP mocking through ACP.`,
      );
  }
  const requestedHome = input.env.HOME ?? process.env.HOME ?? homedir();
  if (!isAbsolute(requestedHome))
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP mocking requires an absolute HOME.',
    );
  await mkdir(requestedHome, {recursive: true});
  const home = await realpath(requestedHome);
  return inTurn(home, input.signal, async () => {
    const started = Date.now();
    const remaining = mcpDeadline(input.timeoutMs, input.signal);
    const env: NodeJS.ProcessEnv = {...process.env, ...input.env, HOME: home};
    Object.assign(env, mcpProxyEnv(env));
    const processOptions = {
      cwd: input.workDir,
      env,
      extendEnv: false,
      reject: false as const,
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
      version = requireMcpVersion('Antigravity', MIN_VERSION, probe);
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
    const view = await createConfigView(home, servers);
    try {
      return await runSession({
        executable,
        input,
        servers,
        version,
        view,
        started,
        remaining,
        processOptions,
        extraArgs: options.extraArgs ?? [],
      });
    } finally {
      await rm(view, {recursive: true, force: true}).catch(() => {});
    }
  });
}

async function runSession(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  version: string;
  view: string;
  started: number;
  remaining: () => number;
  processOptions: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    extendEnv: boolean;
    reject: false;
    cancelSignal?: AbortSignal;
  };
  extraArgs: readonly string[];
}): Promise<McpHarnessRun> {
  const {input, servers, remaining} = options;
  const child = startOwnedProcess(
    options.executable,
    [
      'acp',
      '--process-per-session',
      '--gemini-dir',
      options.view,
      ...(input.permissionMode === 'dangerous'
        ? ['--dangerously-skip-permissions']
        : []),
      ...options.extraArgs,
    ],
    {...options.processOptions, timeout: remaining()},
  );
  let sequence = 0;
  let failure: unknown;
  let taskStarted = false;
  const pending = new Map<
    number,
    {
      resolve(value: JsonObject): void;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const parseAcp = createAntigravityAcpParser();
  const toolEvents: ToolEvent[] = [];
  const send = (value: unknown) =>
    child.stdin?.write(JSON.stringify(value) + '\n');
  const fail = (error: unknown) => {
    failure ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    child.stop();
  };
  const lines = lineSplitter((line) => {
    if (!line.trim()) return;
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) throw new Error('Invalid Antigravity ACP message.');
      for (const tool of logicalMcpToolEvents(
        parseAcp(event).toolEvents,
        servers,
      )) {
        toolEvents.push(tool);
        input.onToolEvent?.(tool);
      }
      if (typeof event.method === 'string' && event.id !== undefined) {
        if (event.method === 'session/request_permission') {
          const params = asRecord(event.params),
            call = asRecord(params.toolCall),
            args = asRecord(call.rawInput ?? call.args);
          const allowed =
            call.name === 'call_mcp_tool' &&
            input.allowedMcpTools?.some(
              ({server, tool}) =>
                server === args.ServerName && tool === args.ToolName,
            );
          const option =
            Array.isArray(params.options) &&
            params.options.find(
              (item) =>
                isRecord(item) &&
                item.kind === (allowed ? 'allow_once' : 'reject_once'),
            );
          send({
            jsonrpc: '2.0',
            id: event.id,
            result: {
              outcome:
                option && isRecord(option)
                  ? {outcome: 'selected', optionId: option.optionId}
                  : {outcome: 'cancelled'},
            },
          });
        } else
          send({
            jsonrpc: '2.0',
            id: event.id,
            error: {
              code: -32601,
              message: 'This client does not implement interactive requests.',
            },
          });
      } else if (typeof event.id === 'number') {
        const request = pending.get(event.id);
        if (request) {
          pending.delete(event.id);
          clearTimeout(request.timer);
          if (event.error)
            request.reject(
              new Error(
                String(
                  asRecord(event.error).message ??
                    'Antigravity ACP request failed.',
                ),
              ),
            );
          else request.resolve(asRecord(event.result));
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => lines.write(chunk));
  void child.then(() => {
    lines.flush();
    fail(new Error('Antigravity ACP exited before completing the request.'));
  }, fail);
  const rpc = (method: string, params: unknown, budget = remaining()) =>
    new Promise<JsonObject>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++sequence;
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Antigravity ACP ${method} exceeded its startup timeout.`,
            ),
          ),
        Math.min(budget, remaining()),
      );
      pending.set(id, {resolve, reject, timer});
      send({jsonrpc: '2.0', id, method, params});
    });
  try {
    const init = await rpc(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {readTextFile: false, writeTextFile: false},
          terminal: false,
        },
        clientInfo: {name: 'dynobox', version: '1'},
      },
      5000,
    );
    if (
      asRecord(asRecord(init.agentCapabilities).mcpCapabilities).http !== true
    )
      throw new McpHarnessError(
        'unsupported_version',
        'Antigravity ACP does not support HTTP MCP sessions.',
      );
    const session = await rpc(
      'session/new',
      {cwd: input.workDir, mcpServers: []},
      5000,
    );
    if (typeof session.sessionId !== 'string')
      throw new Error('Antigravity ACP did not create a session.');
    const sessionId = session.sessionId;
    if (input.model) {
      const models = asRecord(session.models).availableModels;
      const model =
        Array.isArray(models) &&
        models.find(
          (item) =>
            isRecord(item) &&
            (item.modelId === input.model || item.name === input.model),
        );
      if (!isRecord(model))
        throw new McpHarnessError(
          'configuration_failed',
          `Antigravity model "${input.model}" is unavailable in ACP.`,
        );
      await rpc('session/set_model', {sessionId, modelId: model.modelId}, 5000);
    }
    const deadline = Date.now() + Math.min(5000, remaining());
    while (
      Object.values(servers).some((server) => server.isDiscovered?.() === false)
    ) {
      remaining();
      if (Date.now() >= deadline)
        throw new McpHarnessError(
          'not_ready',
          'Antigravity did not discover the declared MCP mocks.',
        );
      await delay(25);
    }
    taskStarted = true;
    const result = await rpc('session/prompt', {
      sessionId,
      prompt: [{type: 'text', text: input.prompt}],
    });
    if (result.stopReason !== 'end_turn')
      throw new Error(`Antigravity stopped: ${String(result.stopReason)}.`);
    child.stop();
    const native = await child;
    remaining();
    const parsed = parseAntigravityJson(native.stdout);
    if (
      parsed.terminalFailure ||
      (!parsed.finalMessage && toolEvents.length === 0)
    )
      throw new Error(
        parsed.errorMessage ?? 'Antigravity finished without a final message.',
      );
    return {
      harnessReady: true,
      version: options.version,
      toolEvents,
      output: {
        exitCode: 0,
        stdout: native.stdout,
        stderr: native.stderr,
        durationMs: Date.now() - options.started,
      },
    };
  } catch (error) {
    child.stop();
    const native = await child;
    let cause = error;
    // Deadline/cancellation takes precedence over the resulting EOF error.
    try {
      remaining();
    } catch (deadlineError) {
      cause = deadlineError;
    }
    throw new McpHarnessError(
      cause instanceof McpHarnessError
        ? cause.category
        : taskStarted
          ? 'execution_failed'
          : 'configuration_failed',
      cause instanceof Error ? cause.message : String(cause),
      {
        exitCode: native.exitCode ?? 1,
        stdout: native.stdout,
        stderr: native.stderr,
        durationMs: Date.now() - options.started,
      },
    );
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    child.stop();
  }
}
