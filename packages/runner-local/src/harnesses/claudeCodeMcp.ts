import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {performance} from 'node:perf_hooks';

import {execa} from 'execa';

import {
  buildClaudeCodeArgs,
  parseClaudeCodeStreamJsonLine,
} from './claudeCode.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {isRecord} from './parsing.js';
import type {HarnessInput, HarnessRunOutput} from './types.js';

// Tested candidate for experimental local execution. Public execution remains
// guarded until the remaining managed/cloud source and release gates pass.
const CANDIDATE_VERSION = '2.1.263';
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 1000;

export type ClaudeCodeMcpOptions = {
  /** Resolve on the real PATH before installing CLI mocks. No child PATH lookup. */
  executable: string;
  input: HarnessInput;
  /** Controller-owned loopback URLs and logical tool names; never serialize. */
  servers: Readonly<Record<string, {url: string; tools: readonly string[]}>>;
  extraArgs?: readonly string[];
  signal?: AbortSignal;
};

export class ClaudeCodeMcpError extends Error {
  constructor(
    readonly category:
      | 'configuration_failed'
      | 'unsupported_version'
      | 'not_ready'
      | 'execution_failed'
      | 'cleanup_failed',
    readonly priorCategory?: ClaudeCodeMcpError['category'],
  ) {
    // Do not attach subprocess errors/causes: they contain URLs, args and stderr.
    super(`Claude Code MCP ${category}.`);
    this.name = 'ClaudeCodeMcpError';
  }
}

/** Internal adapter only. The caller still owns controller sealing/finalization. */
export async function runClaudeCodeWithMcp(
  options: ClaudeCodeMcpOptions,
): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = performance.now();
  const input = {...options.input, env: {...options.input.env}};
  const signal = options.signal;
  const timeoutMs = input.timeoutMs ?? 120_000;
  let directory: string | undefined;
  let output: HarnessRunOutput | undefined;
  let operationError: ClaudeCodeMcpError | undefined;
  const remaining = () => {
    const time = Math.ceil(timeoutMs - (performance.now() - started));
    if (time <= 0 || signal?.aborted)
      throw new ClaudeCodeMcpError('execution_failed');
    return time;
  };
  try {
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      input.prompt.includes('\0') ||
      (input.model !== undefined &&
        (!input.model || /^[-\s]|\0/.test(input.model)))
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    const grantedTools = (input.allowedMcpTools ?? []).map(({server, tool}) => {
      if (
        !Object.hasOwn(options.servers, server) ||
        !options.servers[server]!.tools.includes(tool)
      )
        throw new ClaudeCodeMcpError('configuration_failed');
      return `mcp__${server}__${tool}`;
    });
    const extraArgs = safeExtraArgs([
      ...(options.extraArgs ?? []),
      ...(grantedTools.length === 0
        ? []
        : ['--allowedTools', grantedTools.join(',')]),
    ]);
    const {config, names, tools} = mockConfig(options.servers);
    const executable = await realpath(options.executable);
    const cwd = await realpath(input.workDir);
    const env = {...process.env, ...input.env};
    Object.assign(env, mcpProxyEnv(env));
    remaining();
    directory = await mkdtemp(join(tmpdir(), 'dynobox-claude-mcp-'));
    const configPath = join(directory, 'mcp.json');
    await writeFile(configPath, JSON.stringify(config), {
      mode: 0o600,
      flag: 'wx',
    });
    const configArgs = ['--mcp-config', configPath, '--strict-mcp-config'];
    const processOptions = {
      cwd,
      env,
      extendEnv: false,
      stdin: 'ignore' as const,
      reject: false as const,
      maxBuffer: OUTPUT_LIMIT,
      forceKillAfterDelay: 1000,
      ...(signal === undefined ? {} : {cancelSignal: signal}),
    };
    // --version does not connect servers. Use the same executable, cwd, env and
    // exclusive config as execution; no separate profile or credential copying.
    const version = await execa(executable, [...configArgs, '--version'], {
      ...processOptions,
      timeout: Math.min(5000, remaining()),
    });
    if (
      version.failed ||
      version.stdout.trim() !== `${CANDIDATE_VERSION} (Claude Code)`
    )
      throw new ClaudeCodeMcpError('unsupported_version');

    const args = [
      ...buildClaudeCodeArgs('', [], input.model, input.permissionMode).slice(
        0,
        -1,
      ),
      ...extraArgs,
      ...configArgs,
      '--',
      input.prompt,
    ];
    const child = execa(executable, args, {
      ...processOptions,
      timeout: remaining(),
    });
    let buffer = '';
    let bytes = 0;
    let ready = false;
    let completed = false;
    let failure: ClaudeCodeMcpError | undefined;
    const consume = (line: string) => {
      if (!line.trim() || failure) return;
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new ClaudeCodeMcpError('not_ready');
        if (event.type === 'system' && event.subtype === 'init') {
          if (ready || !startupMatches(event, names, tools))
            throw new ClaudeCodeMcpError('not_ready');
          ready = true;
        }
        if (event.type === 'assistant' || event.type === 'result') {
          if (!ready) throw new ClaudeCodeMcpError('not_ready');
          if (event.type === 'result') {
            if (
              completed ||
              event.is_error !== false ||
              event.subtype !== 'success'
            )
              throw new ClaudeCodeMcpError('execution_failed');
            completed = true;
          }
        }
        for (const tool of parseClaudeCodeStreamJsonLine(line).toolEvents)
          input.onToolEvent?.(tool);
      } catch (error) {
        failure =
          error instanceof ClaudeCodeMcpError
            ? error
            : new ClaudeCodeMcpError('execution_failed');
        child.kill();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) {
        failure = new ClaudeCodeMcpError('execution_failed');
        child.kill();
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    const result = await child;
    consume(buffer);
    if (failure) throw failure;
    if (result.failed) throw new ClaudeCodeMcpError('execution_failed');
    if (!ready || !completed) throw new ClaudeCodeMcpError('not_ready');
    output = {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: performance.now() - started,
      metadata: {mcpHarnessVersion: CANDIDATE_VERSION},
    };
  } catch (error) {
    operationError =
      error instanceof ClaudeCodeMcpError
        ? error
        : new ClaudeCodeMcpError('execution_failed');
  } finally {
    if (directory !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rm(directory, {recursive: true, force: true, maxRetries: 2}),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ClaudeCodeMcpError('cleanup_failed')),
              CLEANUP_TIMEOUT_MS,
            );
          }),
        ]);
      } catch {
        operationError = new ClaudeCodeMcpError(
          'cleanup_failed',
          operationError?.category,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
  if (operationError) throw operationError;
  return {output: output!, harnessReady: true};
}

function mockConfig(servers: ClaudeCodeMcpOptions['servers']) {
  const names = Object.keys(servers);
  const tools = new Set<string>();
  const portableName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (names.length === 0) throw new ClaudeCodeMcpError('configuration_failed');
  const entries = names.map((name) => {
    const server = servers[name]!;
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new ClaudeCodeMcpError('configuration_failed');
    }
    if (
      !portableName.test(name) ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[a-f0-9]{48}$/.test(url.pathname) ||
      server.tools.length === 0
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    for (const tool of server.tools) {
      const flattened = `mcp__${name}__${tool}`;
      if (!portableName.test(tool) || tools.has(flattened))
        throw new ClaudeCodeMcpError('configuration_failed');
      tools.add(flattened);
    }
    return [name, {type: 'http', url: url.href}];
  });
  return {config: {mcpServers: Object.fromEntries(entries)}, names, tools};
}

function startupMatches(
  event: Record<string, unknown>,
  names: string[],
  tools: Set<string>,
): boolean {
  if (
    !Array.isArray(event.mcp_servers) ||
    event.mcp_servers.length !== names.length ||
    !Array.isArray(event.tools) ||
    (event.mcp_server_errors !== undefined &&
      (!Array.isArray(event.mcp_server_errors) ||
        event.mcp_server_errors.length > 0))
  )
    return false;
  const connected = new Set<string>();
  for (const server of event.mcp_servers) {
    if (
      !isRecord(server) ||
      typeof server.name !== 'string' ||
      !names.includes(server.name) ||
      connected.has(server.name) ||
      server.status !== 'connected'
    )
      return false;
    connected.add(server.name);
  }
  const available = new Set<string>();
  for (const tool of event.tools) {
    if (typeof tool !== 'string') return false;
    if (tool.startsWith('mcp__')) {
      if (!tools.has(tool) || available.has(tool)) return false;
      available.add(tool);
    }
  }
  return available.size === tools.size;
}

function safeExtraArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equal = arg.indexOf('=');
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (seen.has(flag)) throw new ClaudeCodeMcpError('configuration_failed');
    seen.add(flag);
    if (flag === '--no-session-persistence' && equal === -1) {
      result.push(flag);
      continue;
    }
    if (
      ![
        '--effort',
        '--max-budget-usd',
        '--permission-mode',
        '--allowedTools',
        '--allowed-tools',
        '--disallowedTools',
        '--disallowed-tools',
        '--append-system-prompt',
      ].includes(flag)
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    const value = equal === -1 ? args[++index] : arg.slice(equal + 1);
    if (
      value === undefined ||
      !value.trim() ||
      value.startsWith('-') ||
      value.includes('\0')
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    if (
      flag === '--effort' &&
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    if (
      flag === '--permission-mode' &&
      ![
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'manual',
        'dontAsk',
        'plan',
      ].includes(value)
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    if (
      flag === '--max-budget-usd' &&
      (!/^\d+(\.\d+)?$/.test(value) ||
        !Number.isFinite(Number(value)) ||
        Number(value) <= 0)
    )
      throw new ClaudeCodeMcpError('configuration_failed');
    // Equals syntax makes even variadic flags consume exactly one supplied value.
    result.push(`${flag}=${value}`);
  }
  return result;
}
