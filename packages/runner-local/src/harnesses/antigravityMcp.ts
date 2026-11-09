import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {Readable, Writable} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {setTimeout as delay} from 'node:timers/promises';

import * as acp from '@agentclientprotocol/sdk';

import {readMcpJsonConfig} from '../mcpMocks/config.js';
import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProcessOutput, probeMcpVersion} from '../mcpMocks/process.js';
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
  const message =
    'Antigravity MCP configuration must contain a valid mcpServers object.';
  const value = await readMcpJsonConfig(path, {
    read: 'Cannot read Antigravity MCP configuration.',
    parse: message,
  });
  if (value.mcpServers !== undefined && !isRecord(value.mcpServers))
    throw new McpHarnessError('configuration_failed', message);
  return value;
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
    const version = await probeMcpVersion(
      executable,
      processOptions,
      remaining,
      (probe) => requireMcpVersion('Antigravity', MIN_VERSION, probe),
    );
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
  let taskStarted = false;
  let protocolError: unknown;
  const parseAcp = createAntigravityAcpParser();
  const toolEvents: ToolEvent[] = [];
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
    } catch (error) {
      protocolError = error;
      // Let EOF close the SDK stream after this stdout callback returns.
      child.stop();
    }
  });
  const decoder = new StringDecoder('utf8');
  child.stdout!.on('data', (chunk: Buffer | string) =>
    lines.write(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
  );
  child.stdout!.on('end', () => {
    lines.write(decoder.end());
    lines.flush();
  });
  const connection = acp
    .client({name: 'dynobox'})
    .onRequest(acp.methods.client.session.requestPermission, ({params}) => {
      const call = params.toolCall,
        args = asRecord(call.rawInput);
      const allowed =
        call.name === 'call_mcp_tool' &&
        input.allowedMcpTools?.some(
          ({server, tool}) =>
            server === args.ServerName && tool === args.ToolName,
        );
      const option = params.options.find(
        (item) => item.kind === (allowed ? 'allow_once' : 'reject_once'),
      );
      return {
        outcome: option
          ? {outcome: 'selected', optionId: option.optionId}
          : {outcome: 'cancelled'},
      };
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    );
  const rpc = async (method: string, params: unknown, budget = remaining()) => {
    const signal = AbortSignal.timeout(Math.min(budget, remaining()));
    try {
      return await connection.agent.request<JsonObject>(method, params, {
        cancellationSignal: signal,
        stopWaitingOnCancel: true,
      });
    } catch (error) {
      if (signal.aborted) {
        remaining();
        throw new McpHarnessError(
          'configuration_failed',
          `Antigravity ACP ${method} exceeded its startup timeout.`,
        );
      }
      throw error;
    }
  };
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
      // ACP accepts valid base IDs that availableModels does not enumerate.
      await rpc(
        'session/set_model',
        {
          sessionId,
          modelId: isRecord(model) ? model.modelId : input.model,
        },
        5000,
      );
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
    if (protocolError) throw protocolError;
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
        ...mcpProcessOutput(native, Date.now() - options.started),
        exitCode: 0,
      },
    };
  } catch (error) {
    child.stop();
    const native = await child;
    let cause = protocolError ?? error;
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
      mcpProcessOutput(native, Date.now() - options.started),
    );
  } finally {
    connection.close();
    child.stop();
  }
}
