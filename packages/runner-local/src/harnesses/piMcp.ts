import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';

import {execa} from 'execa';

import {buildPiArgs, parsePiJson} from './pi.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';

export class PiMcpError extends Error {
  constructor(
    readonly category:
      | 'configuration_failed'
      | 'unsupported_version'
      | 'not_ready'
      | 'execution_failed'
      | 'cleanup_failed',
  ) {
    super(`Pi MCP ${category}.`);
    this.name = 'PiMcpError';
  }
}

export async function runPiWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const input = {
    ...options.input,
    env: {...options.input.env},
    allowedMcpTools: options.input.allowedMcpTools?.map((tool) => ({...tool})),
  };
  const servers = structuredClone(options.servers);
  const timeout = input.timeoutMs ?? 120_000;
  const remaining = () => {
    const value = timeout - (Date.now() - started);
    if (value <= 0 || input.signal?.aborted)
      throw new PiMcpError('execution_failed');
    return value;
  };
  let directory: string | undefined;
  try {
    if (
      !isAbsolute(options.executable) ||
      options.extraArgs?.length ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      !input.prompt ||
      /^[-@]/.test(input.prompt) ||
      input.prompt.includes('\0') ||
      (input.model !== undefined &&
        (!input.model || /^[-\s]|\0/.test(input.model)))
    )
      throw new PiMcpError('configuration_failed');
    const names = new Set<string>();
    if (!Object.keys(servers).length)
      throw new PiMcpError('configuration_failed');
    for (const [server, connection] of Object.entries(servers)) {
      const url = new URL(connection.url);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !connection.tools.length
      )
        throw new PiMcpError('configuration_failed');
      for (const tool of connection.tools) {
        const name = `mcp__${server}__${tool}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name))
          throw new PiMcpError('configuration_failed');
        names.add(name);
      }
    }
    for (const grant of input.allowedMcpTools ?? []) {
      if (
        !Object.hasOwn(servers, grant.server) ||
        !servers[grant.server]!.tools.includes(grant.tool)
      )
        throw new PiMcpError('configuration_failed');
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...input.env,
      PI_OFFLINE: '1',
    };
    const bypass = [
      ...new Set(
        [env.NO_PROXY ?? '', env.no_proxy ?? '', '127.0.0.1,localhost,::1']
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].join(',');
    env.NO_PROXY = bypass;
    env.no_proxy = bypass;
    const processOptions = {
      cwd: await realpath(input.workDir),
      env,
      extendEnv: false,
      reject: false as const,
      stdin: 'ignore' as const,
      maxBuffer: 8 * 1024 * 1024,
      forceKillAfterDelay: 1000,
      ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
    };
    const executable = await realpath(options.executable);
    const version = await execa(executable, ['--version'], {
      ...processOptions,
      timeout: Math.min(5000, remaining()),
    });
    const harnessVersion = version.stdout.trim();
    if (version.failed || !['0.84.2', '0.86.0'].includes(harnessVersion))
      throw new PiMcpError('unsupported_version');
    directory = await mkdtemp(join(tmpdir(), 'dynobox-pi-mcp-'));
    const status = join(directory, 'status.json');
    const bridge = join(directory, 'bridge.mjs');
    await writeFile(bridge, piBridgeSource(servers, status), {mode: 0o600});
    const result = await execa(
      executable,
      buildPiArgs(
        input.prompt,
        ['--no-extensions', '-e', bridge],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, timeout: remaining()},
    );
    remaining();
    if (result.failed) throw new PiMcpError('execution_failed');
    let state: unknown;
    try {
      state = JSON.parse(await readFile(status, 'utf8'));
    } catch {
      throw new PiMcpError('not_ready');
    }
    if (JSON.stringify(state) !== JSON.stringify({ready: true, closed: true}))
      throw new PiMcpError('not_ready');
    const parsed = parsePiJson(result.stdout);
    if (parsed.terminalFailure || !parsed.finalMessage)
      throw new PiMcpError('execution_failed');
    for (const event of parsed.toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        metadata: {mcpHarnessVersion: harnessVersion},
      },
    };
  } catch (error) {
    if (error instanceof PiMcpError) throw error;
    throw new PiMcpError('execution_failed');
  } finally {
    if (directory) {
      await rm(directory, {recursive: true, force: true}).catch(() => {
        throw new PiMcpError('cleanup_failed');
      });
    }
  }
}

// Loaded only by the pinned Pi runtime. Transport dependencies resolve from
// runner-local, including when the runner is bundled into dist/index.js.
function piBridgeSource(servers: McpServerConnections, status: string): string {
  return `
import {writeFile} from 'node:fs/promises';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StreamableHTTPClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const servers = ${JSON.stringify(servers)};
const status = ${JSON.stringify(status)};
export default async function(pi) {
  const clients = [];
  const names = [];
  let ready = false;
  const fatal = () => { process.exitCode = 1; process.exit(1); };
  try {
    for (const [server, connection] of Object.entries(servers)) {
      const client = new Client({name: 'dynobox-pi', version: '1.0.0'});
      client.onerror = fatal;
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url)));
      const listing = await client.listTools();
      if (listing.nextCursor || listing.tools.length !== connection.tools.length || connection.tools.some(name => !listing.tools.some(tool => tool.name === name))) throw new Error('discovery');
      for (const tool of listing.tools) {
        const name = 'mcp__' + server + '__' + tool.name;
        names.push(name);
        pi.registerTool({name, label: server + '/' + tool.name,
          description: tool.description || server + '/' + tool.name,
          parameters: tool.inputSchema,
          async execute(id, args, signal) {
            let result;
            try { result = await client.callTool({name: tool.name, arguments: args}, undefined, {signal}); }
            catch { fatal(); }
            if (result.isError) throw new Error(JSON.stringify(result.content));
            return {content: result.content, details: result.structuredContent || {}};
          }
        });
      }
    }
    pi.on('session_start', async () => {
      if (!names.every(name => pi.getActiveTools().includes(name))) fatal();
      ready = true;
      await writeFile(status, JSON.stringify({ready: true, closed: false}), {mode: 0o600});
    });
    pi.on('session_shutdown', async () => {
      try {
        await Promise.all(clients.map(client => client.close()));
        await writeFile(status, JSON.stringify({ready, closed: true}), {mode: 0o600});
      } catch { fatal(); }
    });
  } catch { fatal(); }
}
`;
}
