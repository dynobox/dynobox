import {randomBytes} from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ErrorCode, McpError} from '@modelcontextprotocol/sdk/types.js';
import {parse, type ParseError} from 'jsonc-parser';
import picomatch from 'picomatch';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {
  buildCursorArgs,
  createCursorToolEventDeduper,
  parseCursorJson,
  parseCursorJsonLine,
} from './cursor.js';
import {asRecord, isRecord, type JsonObject} from './parsing.js';
import {lineSplitter} from './runStreamingHarness.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpHarnessRun,
  McpInventory,
  McpServerConnections,
  ToolEvent,
} from './types.js';

const MIN_VERSION = '2026.10.22';
const VALUE_FLAGS = new Set([
  '--api-key',
  '--auth-token',
  '--header',
  '-H',
  '--endpoint',
  '-e',
  '--plugin-dir',
  '--http-version',
]);
const SWITCH_FLAGS = new Set(['--insecure', '-k']);

async function nativeProjectRoot(workDir: string): Promise<string> {
  for (let directory = workDir; ; directory = dirname(directory)) {
    const marker = await stat(join(directory, '.git')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (marker) return directory;
    if (dirname(directory) === directory) return workDir;
  }
}

function deniesMock(rule: string, server: string, tool: string): boolean {
  const pattern = rule.match(/^\s*Mcp\s*\((.*)\)\s*$/)?.[1];
  if (pattern === undefined || !pattern.includes(':')) return false;
  const colon = pattern.indexOf(':');
  return [
    [pattern.slice(0, colon), server],
    [pattern.slice(colon + 1), tool],
  ].every(([glob, value]) => {
    const normalized = glob!.trim().toLowerCase(),
      target = value!.trim().toLowerCase();
    try {
      return picomatch(normalized, {dot: true})(target);
    } catch {
      return normalized === target;
    }
  });
}

/** Use the directory name produced by Cursor, rather than duplicating its path codec. */
async function inheritMcpState(
  data: string,
  originalData: string,
): Promise<void> {
  const projects = (
    await readdir(join(data, 'projects'), {withFileTypes: true})
  ).filter((entry) => entry.isDirectory());
  if (projects.length !== 1)
    throw new McpHarnessError(
      'configuration_failed',
      'Cursor did not create an unambiguous workspace MCP state directory.',
    );
  const source = join(originalData, 'projects', projects[0]!.name);
  const target = join(data, 'projects', projects[0]!.name);
  const entries = await readdir(source, {withFileTypes: true}).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.name.startsWith('mcp-') || entry.isDirectory()) continue;
    // Native auth writes through this file, preserving refreshes at the normal path.
    // Approval, disable, and selection changes remain owned by this run.
    if (entry.name === 'mcp-auth.json')
      await symlink(join(source, entry.name), join(target, entry.name));
    else await copyFile(join(source, entry.name), join(target, entry.name));
  }
}

async function readConfig(path: string): Promise<JsonObject> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new McpHarnessError(
      'configuration_failed',
      'Cannot read Cursor MCP configuration.',
    );
  }
  const errors: ParseError[] = [];
  const config: unknown = parse(source, errors, {allowTrailingComma: true});
  if (errors.length || !isRecord(config))
    throw new McpHarnessError(
      'configuration_failed',
      'Cursor configuration must contain a valid JSON object.',
    );
  return config;
}

/** Passive names only; project, plugin and managed sources may add servers. */
export async function inspectCursorMcp(
  input: Pick<HarnessInput, 'env'>,
): Promise<McpInventory> {
  const home = input.env.HOME ?? process.env.HOME ?? homedir();
  const config = await readConfig(join(home, '.cursor', 'mcp.json'));
  return {servers: Object.keys(asRecord(config.mcpServers)), complete: false};
}

/** Native per-run disable/approval state leaves model login and profiles in place. */
export async function runCursorWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<McpHarnessRun> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  remaining();
  const extras = options.extraArgs ?? [];
  for (let index = 0; index < extras.length; index++) {
    const argument = extras[index]!;
    const flag = argument.split('=')[0]!;
    if (SWITCH_FLAGS.has(flag) && argument === flag) continue;
    if (VALUE_FLAGS.has(flag)) {
      if (
        argument.includes('=')
          ? argument.slice(flag.length + 1) !== ''
          : extras[++index] !== undefined
      )
        continue;
    }
    throw new McpHarnessError(
      'configuration_failed',
      `Cursor extra argument ${/^--?[A-Za-z][A-Za-z0-9-]*$/.test(flag) ? flag : '(positional value)'} is unsupported or missing a value for MCP mocking.`,
    );
  }
  // Native mcp commands derive state from cwd; --workspace must use the same path.
  const workDir = await realpath(input.workDir);
  const projectRoot = await nativeProjectRoot(workDir);
  const env = {...process.env, ...input.env};
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd: workDir,
    env,
    extendEnv: false,
    reject: false as const,
    stdin: 'ignore' as const,
    ...(input.signal ? {cancelSignal: input.signal} : {}),
  };
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...processOptions,
    timeout: Math.min(5000, remaining()),
  });
  let output: HarnessRunOutput | undefined;
  const snapshot = (result: {
    exitCode?: number;
    stdout: string;
    stderr: string;
  }): HarnessRunOutput => ({
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
  });
  output = snapshot(probe);
  try {
    remaining();
    requireMcpVersion(
      'Cursor',
      MIN_VERSION,
      probe,
      (stdout) => stdout.match(/^\d{4}\.\d{2}\.\d{2}(?=-|\s|$)/)?.[0] ?? null,
    );
  } catch (error) {
    throw new McpHarnessError(
      error instanceof McpHarnessError ? error.category : 'execution_failed',
      error instanceof Error ? error.message : String(error),
      output,
    );
  }
  const version = probe.stdout.trim();
  const git = await startOwnedProcess('git', ['rev-parse', '--show-toplevel'], {
    ...processOptions,
    timeout: Math.min(5000, remaining()),
  });
  remaining();
  if (git.timedOut)
    throw new McpHarnessError(
      'timed_out',
      'Cursor Git root check exceeded its timeout.',
    );
  const gitRoot =
    git.failed || git.stdout.trim() === ''
      ? workDir
      : await realpath(resolve(workDir, git.stdout.trim()));
  if (gitRoot !== projectRoot)
    throw new McpHarnessError(
      'configuration_failed',
      'Cursor MCP commands and Git disagree on the project root. Check the workspace Git configuration and any Git mocks.',
    );
  const directory = join(workDir, '.cursor');
  const paths = [join(directory, 'cli.json')];
  // Never follow a fixture symlink into the user's real configuration.
  for (const path of [directory, ...paths]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new McpHarnessError(
        'configuration_failed',
        'Cursor MCP overrides require regular workspace configuration paths, not symlinks.',
      );
  }
  const home = env.HOME ?? homedir();
  const configs = await Promise.all([
    readConfig(join(home, '.cursor', 'mcp.json')),
    readConfig(join(projectRoot, '.cursor', 'mcp.json')),
  ]);
  for (const config of configs) {
    if (config.mcpServers !== undefined && !isRecord(config.mcpServers))
      throw new McpHarnessError(
        'configuration_failed',
        'Cursor MCP configuration must contain a valid mcpServers object.',
      );
    for (const name of Object.keys(servers))
      if ('command' in asRecord(asRecord(config.mcpServers)[name]))
        throw new McpHarnessError(
          'configuration_failed',
          `Cursor MCP target "${name}" uses stdio; selective mocking supports HTTP targets.`,
        );
  }
  const permissions = await readConfig(paths[0]!);
  const existing = asRecord(permissions.permissions);
  const profile = env.CURSOR_CONFIG_DIR?.trim()
    ? env.CURSOR_CONFIG_DIR
    : env.XDG_CONFIG_HOME?.trim()
      ? join(env.XDG_CONFIG_HOME, 'cursor')
      : join(home, '.cursor');
  const effective = {
    ...asRecord(
      (await readConfig(resolve(workDir, profile, 'cli-config.json')))
        .permissions,
    ),
  };
  const directories: string[] = [];
  for (let directory = workDir; ; directory = dirname(directory)) {
    directories.unshift(directory);
    if (directory === projectRoot) break;
  }
  const layers = [
    effective,
    ...(await Promise.all(
      directories.map(async (directory) =>
        asRecord(
          (directory === workDir
            ? permissions
            : await readConfig(join(directory, '.cursor', 'cli.json'))
          ).permissions,
        ),
      ),
    )),
  ];
  for (const entries of layers)
    for (const key of ['allow', 'deny'])
      if (entries[key] !== undefined) {
        if (
          !Array.isArray(entries[key]) ||
          !entries[key].every((item) => typeof item === 'string')
        )
          throw new McpHarnessError(
            'configuration_failed',
            'Cursor permissions allow and deny must be arrays of strings.',
          );
        effective[key] = entries[key];
      }
  const originals = await Promise.all(
    paths.map(async (path) => {
      try {
        return {content: await readFile(path), mode: (await lstat(path)).mode};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      }
    }),
  );
  const aliases: Record<string, string> = {};
  const definitions: Record<string, {url: string}> = {};
  const pluginName = 'dxb_plugin_' + randomBytes(6).toString('hex');
  // Cursor replaces permission arrays when a project supplies them. Preserve
  // each inherited array unless this workspace already overrides it.
  const allow = [...((effective.allow ?? []) as string[])];
  const deny = (effective.deny ?? []) as string[];
  for (const [logical, connection] of Object.entries(servers)) {
    const native = 'dxb_' + randomBytes(10).toString('hex');
    aliases[native] = logical;
    aliases[`plugin-${pluginName}-${native}`] = logical;
    for (const tool of connection.tools) {
      const blocked = deny.find((rule) => deniesMock(rule, native, tool));
      if (blocked)
        throw new McpHarnessError(
          'configuration_failed',
          `Cursor permissions deny MCP mock tool "${logical}.${tool}" via ${blocked}.`,
        );
    }
    definitions[native] = {url: connection.url};
    allow.push(...connection.tools.map((tool) => `Mcp(${native}:${tool})`));
  }
  const originalData = resolve(
    workDir,
    env.CURSOR_DATA_DIR?.trim() ? env.CURSOR_DATA_DIR : join(home, '.cursor'),
  );
  const data = await mkdtemp(join(tmpdir(), 'dynobox-cursor-mcp-'));
  env.CURSOR_DATA_DIR = data;
  try {
    const plugin = join(data, pluginName);
    await mkdir(join(plugin, '.cursor-plugin'), {recursive: true});
    await writeFile(
      join(plugin, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({name: pluginName, version: '1.0.0'}),
    );
    await writeFile(
      join(plugin, 'mcp.json'),
      JSON.stringify({mcpServers: definitions}),
      {mode: 0o600},
    );
    await mkdir(directory, {recursive: true});
    await writeFile(
      paths[0]!,
      JSON.stringify({
        ...permissions,
        permissions: {...existing, allow, deny},
      }),
      {mode: 0o600},
    );
    const command = async (args: string[], label: string) => {
      const result = await startOwnedProcess(executable, [...extras, ...args], {
        ...processOptions,
        timeout: Math.min(30000, remaining()),
      });
      output = snapshot(result);
      remaining();
      if (result.timedOut)
        throw new McpHarnessError(
          'timed_out',
          `Cursor ${label} exceeded its timeout.`,
        );
      if (result.failed || result.exitCode !== 0)
        throw new McpHarnessError(
          'not_ready',
          `Cursor ${label} failed. See local debug output.`,
        );
      return result.stdout;
    };
    const targets = Object.keys(servers);
    await command(['mcp', 'disable', targets[0]!], 'MCP state preparation');
    await inheritMcpState(data, originalData);
    for (const logical of targets)
      await command(['mcp', 'disable', logical], 'MCP target disable');
    for (const [logical, connection] of Object.entries(servers)) {
      const client = new Client({
        name: 'dynobox-cursor-preflight',
        version: '1',
      });
      try {
        const request = () => ({
          timeout: Math.min(30000, remaining()),
          ...(input.signal ? {signal: input.signal} : {}),
        });
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(connection.url),
          ) as Transport,
          request(),
        );
        const listed = await client.listTools({}, request());
        const tools = new Set(listed.tools.map((tool) => tool.name));
        if (connection.tools.some((tool) => !tools.has(tool)))
          throw new Error('Missing declared tool.');
      } catch (error) {
        remaining();
        throw new McpHarnessError(
          error instanceof McpError && error.code === ErrorCode.RequestTimeout
            ? 'timed_out'
            : 'not_ready',
          `Cursor could not discover every declared MCP mock tool for "${logical}".`,
        );
      } finally {
        await client.close();
      }
      if (connection.isDiscovered?.() === false)
        throw new McpHarnessError(
          'not_ready',
          `Cursor did not discover MCP mock server "${logical}".`,
        );
    }
    const discoveries = new Map(
      Object.entries(servers).map(([name, connection]) => [
        name,
        connection.discoveryCount?.(),
      ]),
    );
    const child = startOwnedProcess(
      executable,
      buildCursorArgs(
        workDir,
        input.prompt,
        [...extras, '--plugin-dir', plugin],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, timeout: remaining()},
    );
    const toolEvents: ToolEvent[] = [];
    const inputs = new Map<string, unknown>();
    const shouldEmit = createCursorToolEventDeduper();
    let completed = false;
    let failure: McpHarnessError | undefined;
    const lines = lineSplitter((line) => {
      if (!line.trim() || failure) return;
      try {
        const parsed = parseCursorJsonLine(line, 1, inputs, aliases);
        if (parsed.completed) completed = true;
        if (parsed.terminalFailure)
          throw new McpHarnessError(
            'execution_failed',
            parsed.errorMessage ?? 'Cursor reported a failed turn.',
          );
        for (const event of parsed.toolEvents) {
          if (!shouldEmit(event, line)) continue;
          toolEvents.push(event);
          input.onToolEvent?.(event);
        }
      } catch (error) {
        failure =
          error instanceof McpHarnessError
            ? error
            : new McpHarnessError(
                'execution_failed',
                error instanceof SyntaxError
                  ? 'Cursor emitted unparseable JSON output.'
                  : `Cursor event processing failed: ${error instanceof Error ? error.message : String(error)}`,
              );
        child.stop();
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => lines.write(chunk));
    const result = await child;
    output = {...snapshot(result), metadata: {cursorMcpAliases: aliases}};
    lines.flush();
    if (failure) throw failure;
    remaining();
    if (result.timedOut)
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    if (
      result.failed ||
      result.exitCode !== 0 ||
      !completed ||
      inputs.size !== 0 ||
      parseCursorJson(result.stdout, aliases).terminalFailure
    )
      throw new McpHarnessError(
        'execution_failed',
        'Cursor exited without completing its turn.',
      );
    for (const [name, connection] of Object.entries(servers)) {
      const before = discoveries.get(name);
      if (
        connection.isDiscovered?.() === false ||
        (before !== undefined && connection.discoveryCount!() <= before)
      )
        throw new McpHarnessError(
          'not_ready',
          `Cursor's task process did not discover MCP mock server "${name}".`,
        );
    }
    return {harnessReady: true, version, toolEvents, output};
  } catch (error) {
    throw new McpHarnessError(
      error instanceof McpHarnessError ? error.category : 'execution_failed',
      error instanceof Error ? error.message : String(error),
      output,
    );
  } finally {
    for (let index = 0; index < paths.length; index++) {
      const original = originals[index];
      if (original)
        await writeFile(paths[index]!, original.content, {mode: original.mode});
      else await rm(paths[index]!, {force: true});
    }
    await rm(data, {recursive: true, force: true});
  }
}
