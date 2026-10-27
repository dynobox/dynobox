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
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

import {execa} from 'execa';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {
  buildAntigravityArgs,
  parseAntigravityJson,
  removeDynoboxProjectRecords,
} from './antigravity.js';
import {asRecord, isRecord} from './parsing.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

// Oldest release whose project-scoped MCP config was verified natively.
const MIN_VERSION = '1.2.11';

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
// then start without the mock tool. The atomic directory also excludes runs
// in other processes. Never remove a lock owned by another run.
async function inTurn<T>(
  home: string,
  remaining: () => number,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const lock = join(home, '.gemini', 'dynobox-mcp.lock');
  await mkdir(dirname(lock), {recursive: true});
  for (;;) {
    remaining();
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await delay(Math.min(50, remaining()), undefined, {signal}).catch(() =>
        remaining(),
      );
    }
  }
  try {
    remaining();
    return await run();
  } finally {
    await rmdir(lock);
  }
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
  const started = Date.now();
  const {input, servers, executable} = options;
  for (const arg of options.extraArgs ?? []) {
    const flag = arg.split('=')[0]!;
    if (WORKSPACE_FLAGS.has(flag))
      throw new McpHarnessError(
        'configuration_failed',
        `Antigravity extra argument ${flag} conflicts with MCP mocking.`,
      );
  }
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const cwd = input.workDir;
  const requestedHome = input.env.HOME ?? process.env.HOME;
  if (!requestedHome)
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP mocking requires HOME to locate its config.',
    );
  await mkdir(requestedHome, {recursive: true});
  const home = await realpath(requestedHome);

  return inTurn(home, remaining, input.signal, async () => {
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
    const probe = await execa(executable, ['--version'], {
      ...processOptions,
      timeout: Math.min(5000, remaining()),
    });
    remaining();
    const version = requireMcpVersion('Antigravity', MIN_VERSION, probe);
    const plugins = await execa(executable, ['plugin', 'list'], {
      ...processOptions,
      timeout: Math.min(5000, remaining()),
    });
    if (plugins.failed || plugins.stdout.trim() !== 'No imported plugins.')
      throw new McpHarnessError(
        'configuration_failed',
        'Antigravity has imported plugins that could load other MCP servers; remove them to use MCP mocks.',
      );

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
      const result = await execa(
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
      remaining();
      if (result.failed)
        throw new McpHarnessError(
          'execution_failed',
          `Antigravity exited with code ${result.exitCode ?? 'unknown'}.`,
        );
      const parsed = parseAntigravityJson(result.stdout);
      if (parsed.terminalFailure || !parsed.finalMessage)
        throw new McpHarnessError(
          'execution_failed',
          parsed.errorMessage ??
            'Antigravity finished without a final message.',
        );
      for (const event of parsed.toolEvents) input.onToolEvent?.(event);
      return {
        harnessReady: true,
        version,
        output: {
          exitCode: 0,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - started,
        },
      };
    } finally {
      await Promise.all([
        rm(projectConfig, {force: true}).then(() =>
          // Keep the directory if the agent wrote other files into it.
          createdAgentsDir ? rmdir(dirname(projectConfig)).catch(() => {}) : {},
        ),
        rm(projectRecord, {force: true}),
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
