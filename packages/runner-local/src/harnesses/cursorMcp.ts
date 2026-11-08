import {randomBytes} from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {parse, type ParseError} from 'jsonc-parser';

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
    const flag = extras[index]!;
    if (SWITCH_FLAGS.has(flag)) continue;
    if (VALUE_FLAGS.has(flag) && extras[++index] !== undefined) continue;
    throw new McpHarnessError(
      'configuration_failed',
      `Cursor extra argument ${flag} is unsupported or missing a value for MCP mocking.`,
    );
  }
  // Native mcp commands derive state from cwd; --workspace must use the same path.
  const workDir = await realpath(input.workDir);
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
  const directory = join(workDir, '.cursor');
  const paths = [join(directory, 'mcp.json'), join(directory, 'cli.json')];
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
    readConfig(paths[0]!),
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
  const project = configs[1]!;
  const permissions = await readConfig(paths[1]!);
  const existing = asRecord(permissions.permissions);
  const profile = env.CURSOR_CONFIG_DIR?.trim()
    ? env.CURSOR_CONFIG_DIR
    : env.XDG_CONFIG_HOME?.trim()
      ? join(env.XDG_CONFIG_HOME, 'cursor')
      : join(home, '.cursor');
  const inherited = asRecord(
    (await readConfig(resolve(workDir, profile, 'cli-config.json')))
      .permissions,
  );
  for (const entries of [existing, inherited])
    for (const key of ['allow', 'deny'])
      if (
        entries[key] !== undefined &&
        (!Array.isArray(entries[key]) ||
          !entries[key].every((item) => typeof item === 'string'))
      )
        throw new McpHarnessError(
          'configuration_failed',
          'Cursor permissions allow and deny must be arrays of strings.',
        );
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
  const data = await mkdtemp(join(tmpdir(), 'dynobox-cursor-mcp-'));
  env.CURSOR_DATA_DIR = data;
  const aliases: Record<string, string> = {};
  const definitions = {...asRecord(project.mcpServers)};
  // Cursor replaces permission arrays when a project supplies them. Preserve
  // each inherited array unless this workspace already overrides it.
  const allow = [...((existing.allow ?? inherited.allow ?? []) as string[])];
  const deny = existing.deny ?? inherited.deny ?? [];
  for (const [logical, connection] of Object.entries(servers)) {
    const native = 'dxb_' + randomBytes(10).toString('hex');
    aliases[native] = logical;
    // Keep an inert entry so the native disable command works for new targets too.
    definitions[logical] = {url: connection.url};
    definitions[native] = {url: connection.url};
    allow.push(...connection.tools.map((tool) => `Mcp(${native}:${tool})`));
  }
  try {
    await mkdir(directory, {recursive: true});
    await writeFile(
      paths[0]!,
      JSON.stringify({...project, mcpServers: definitions}),
      {mode: 0o600},
    );
    await writeFile(
      paths[1]!,
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
    for (const logical of Object.keys(servers))
      await command(['mcp', 'disable', logical], 'MCP target disable');
    for (const [native, logical] of Object.entries(aliases)) {
      await command(['mcp', 'enable', native], 'mock approval');
      const listed = await command(
        ['mcp', 'list-tools', native],
        'mock discovery',
      );
      const tools = new Set(
        [...listed.matchAll(/^- ([^\s]+) \(/gm)].map((match) => match[1]),
      );
      if (
        servers[logical]!.tools.some((tool) => !tools.has(tool)) ||
        servers[logical]!.isDiscovered?.() === false
      )
        throw new McpHarnessError(
          'not_ready',
          `Cursor did not discover every declared MCP mock tool for "${logical}".`,
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
        extras,
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
