import {randomUUID} from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {
  buildAntigravityArgs,
  parseAntigravityJson,
  removeDynoboxProjectRecords,
} from './antigravity.js';
import {asRecord, createToolEvent, isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpHarnessRun,
  McpServerConnections,
  ToolEvent,
} from './types.js';

// Oldest release whose project-scoped MCP config was verified natively.
const MIN_VERSION = '1.2.11';

// `agy plugin list` output with nothing installed, across supported releases.
const NO_PLUGINS = new Set(['No imported plugins.', 'No plugins installed.']);

// Extra arguments that change the workspace, project or agent, and with it the
// MCP sources Antigravity loads beside the mocks.
const WORKSPACE_FLAGS = new Set([
  '--add-dir',
  '--project',
  '--new-project',
  '--agent',
  '--continue',
  '-c',
  '--conversation',
]);

// Antigravity keeps each MCP tool definition in HOME, keyed only by server
// name, and concurrent agy processes rewrite it under each other; a run could
// then start without the mock tool. Runs in this process that share a HOME
// therefore take turns. Separate dynobox processes sharing a HOME are not
// coordinated.
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

/**
 * Antigravity calls every MCP tool through one native `call_mcp_tool` tool.
 * Report mock calls under their logical `mcp__<server>__<tool>` names, so
 * evidence checks can compare them with the mock's receipts.
 */
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

/**
 * Antigravity has no flag to ignore inherited MCP sources, so the run uses the
 * installed login only when no other MCP source could load beside the mocks.
 */
export async function runAntigravityWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<McpHarnessRun> {
  const {input, servers, executable} = options;
  for (const arg of options.extraArgs ?? []) {
    const flag = arg.split('=')[0]!;
    if (WORKSPACE_FLAGS.has(flag))
      throw new McpHarnessError(
        'configuration_failed',
        `Antigravity extra argument ${flag} conflicts with MCP mocking.`,
      );
  }
  const cwd = input.workDir;
  const requestedHome = input.env.HOME ?? process.env.HOME;
  if (!requestedHome)
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP mocking requires HOME to locate its config.',
    );
  await mkdir(requestedHome, {recursive: true});
  const home = await realpath(requestedHome);

  return inTurn(home, input.signal, async () => {
    // Waiting for a turn does not count against the run's timeout.
    const started = Date.now();
    const remaining = mcpDeadline(input.timeoutMs, input.signal);
    await assertNoInheritedMcpSources(cwd, home);
    await removeDynoboxProjectRecords(home);
    const env = {
      ...process.env,
      ...input.env,
      HOME: home,
      ...mcpProxyEnv({...process.env, ...input.env}),
    };
    const processOptions = {
      cwd,
      env,
      extendEnv: false,
      reject: false as const,
      stdin: 'ignore' as const,
      forceKillAfterDelay: 1000,
      ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
    };
    const preflight = async <T>(
      args: string[],
      check: (result: Awaited<ReturnType<typeof startOwnedProcess>>) => T,
    ) => {
      const result = await startOwnedProcess(executable, args, {
        ...processOptions,
        timeout: Math.min(5000, remaining()),
      });
      try {
        remaining();
        if (result.timedOut)
          throw new McpHarnessError(
            'timed_out',
            'MCP run exceeded its timeout.',
          );
        return check(result);
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
    };
    const version = await preflight(['--version'], (result) =>
      requireMcpVersion('Antigravity', MIN_VERSION, result),
    );
    await preflight(['plugin', 'list'], (plugins) => {
      if (plugins.failed || !NO_PLUGINS.has(plugins.stdout.trim()))
        throw new McpHarnessError(
          'configuration_failed',
          'Antigravity has imported plugins that could load other MCP servers; remove them to use MCP mocks.',
        );
    });

    const projectId = randomUUID();
    const projectRecord = join(
      home,
      '.gemini',
      'config',
      'projects',
      `${projectId}.json`,
    );
    const projectConfig = join(cwd, '.agents', 'mcp_config.json');
    // Remove the .agents directory after the run only when this run created it.
    const createdAgentsDir =
      (await mkdir(dirname(projectConfig), {recursive: true})) !== undefined;
    // Antigravity copies each MCP tool definition here and the model reads it.
    // The inherited-source check means only mocks can own these names, and
    // taking turns means no other Dynobox MCP run is using them.
    const toolDirs = Object.keys(servers).map((name) =>
      join(home, '.gemini', 'antigravity-cli', 'mcp', name),
    );
    let output: HarnessRunOutput | undefined;
    try {
      await mkdir(dirname(projectRecord), {recursive: true});
      await writeFile(
        projectRecord,
        JSON.stringify({
          id: projectId,
          name: `dynobox-${projectId}`,
          projectResources: {
            resources: [{folderUri: pathToFileURL(cwd).href}],
          },
          ...(input.allowedMcpTools?.length
            ? {
                permissionGrants: {
                  permissionGrants: {
                    allow: input.allowedMcpTools.map(
                      ({server, tool}) => `mcp(${server}/${tool})`,
                    ),
                  },
                  v2Migrated: true,
                },
              }
            : {}),
        }),
      );
      await writeFile(
        projectConfig,
        JSON.stringify({
          mcpServers: Object.fromEntries(
            Object.entries(servers).map(([name, server]) => [
              name,
              {serverUrl: server.url},
            ]),
          ),
        }),
      );
      const result = await startOwnedProcess(
        executable,
        buildAntigravityArgs(
          cwd,
          input.prompt,
          options.extraArgs ?? [],
          input.model,
          input.permissionMode,
          input.timeoutMs === undefined ? undefined : remaining(),
          projectId,
        ),
        {...processOptions, timeout: remaining()},
      );
      output = {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
      let parsed: ReturnType<typeof parseAntigravityJson> | undefined;
      let parseError: unknown;
      try {
        parsed = parseAntigravityJson(result.stdout);
      } catch (error) {
        parseError = error;
      }
      // Report attempted calls even when the run then fails.
      const toolEvents = logicalMcpToolEvents(
        parsed?.toolEvents ?? [],
        servers,
      );
      for (const event of toolEvents) input.onToolEvent?.(event);
      remaining();
      if (result.timedOut)
        throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
      if (result.failed)
        throw new McpHarnessError(
          'execution_failed',
          `Antigravity exited with code ${result.exitCode ?? 'unknown'}.`,
        );
      if (parsed === undefined) throw parseError;
      if (parsed.deniedMcp)
        throw new McpHarnessError(
          'execution_failed',
          'Antigravity denied a mock tool call. Check the permission mode.',
        );
      // A successful run may end with tool calls and no text.
      if (
        parsed.terminalFailure ||
        (!parsed.finalMessage && toolEvents.length === 0)
      )
        throw new McpHarnessError(
          'execution_failed',
          parsed.errorMessage ??
            'Antigravity finished without a final message.',
        );
      return {
        harnessReady: true,
        version,
        output,
        toolEvents,
      };
    } catch (error) {
      if (output !== undefined)
        throw new McpHarnessError(
          error instanceof McpHarnessError
            ? error.category
            : 'execution_failed',
          error instanceof Error ? error.message : String(error),
          output,
        );
      throw error;
    } finally {
      // Best effort: a cleanup error must not replace the run's result.
      await Promise.all([
        rm(projectConfig, {force: true})
          .then(() =>
            // Keep the directory if the agent wrote other files into it.
            createdAgentsDir ? rmdir(dirname(projectConfig)) : undefined,
          )
          .catch(() => {}),
        rm(projectRecord, {force: true}).catch(() => {}),
        ...toolDirs.map((dir) =>
          rm(dir, {recursive: true, force: true}).catch(() => {}),
        ),
      ]);
    }
  });
}

async function assertNoInheritedMcpSources(
  cwd: string,
  home: string,
): Promise<void> {
  const inherited = (source: string) =>
    new McpHarnessError(
      'configuration_failed',
      `Antigravity would load MCP servers from ${source} beside the mocks; remove it to use MCP mocks.`,
    );
  for (const path of [
    join(home, '.gemini', 'config', 'mcp_config.json'),
    join(home, '.gemini', 'settings.json'),
    join(home, '.gemini', 'config', 'config.json'),
  ]) {
    const source = await readFile(path, 'utf8').catch(() => '');
    if (!source.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw inherited(path);
    }
    const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
    if (
      servers !== undefined &&
      (!isRecord(servers) || Object.keys(servers).length > 0)
    )
      throw inherited(path);
  }
  const directories = [
    join(home, '.gemini', 'config', 'plugins'),
    join(home, '.gemini', 'antigravity-cli', 'plugins'),
    join(home, '.gemini', 'config', 'agents'),
    join(home, '.gemini', 'antigravity-cli', 'agents'),
  ];
  for (let directory = cwd; ; directory = dirname(directory)) {
    // Antigravity reads workspace customizations from each of these names.
    for (const name of ['.agents', '.agent', '_agents', '_agent']) {
      const config = join(directory, name, 'mcp_config.json');
      if ((await readFile(config).catch(() => undefined)) !== undefined)
        throw inherited(config);
      // plugins.json can list plugin directories that carry MCP servers.
      const pluginList = join(directory, name, 'plugins.json');
      const source = await readFile(pluginList, 'utf8').catch(() => undefined);
      if (source !== undefined) {
        let entries: unknown;
        try {
          entries = asRecord(JSON.parse(source)).entries;
        } catch {
          throw inherited(pluginList);
        }
        if (!Array.isArray(entries) || entries.length > 0)
          throw inherited(pluginList);
      }
      directories.push(
        join(directory, name, 'plugins'),
        join(directory, name, 'agents'),
      );
    }
    if (dirname(directory) === directory) break;
  }
  for (const directory of directories)
    if ((await readdir(directory).catch(() => [])).length > 0)
      throw inherited(directory);
}
