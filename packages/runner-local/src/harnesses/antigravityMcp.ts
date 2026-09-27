import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {execa} from 'execa';

import {
  buildAntigravityArgs,
  parseAntigravityJson,
  removeDynoboxProjectRecords,
} from './antigravity.js';
import {mcpDeadline, McpHarnessError, requireMcpVersion} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
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
// then start without the mock tool. Runs that share a HOME take turns.
const homeTurns = new Map<string, Promise<void>>();

function inTurn<T>(home: string, run: () => Promise<T>): Promise<T> {
  const result = (homeTurns.get(home) ?? Promise.resolve()).then(run);
  const settled = result.then(
    () => {},
    () => {},
  );
  homeTurns.set(home, settled);
  void settled.then(() => {
    if (homeTurns.get(home) === settled) homeTurns.delete(home);
  });
  return result;
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
  const home = input.env.HOME ?? process.env.HOME;
  if (!home)
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP mocking requires HOME to locate its config.',
    );
  await assertNoInheritedMcpSources(cwd, home);
  await removeDynoboxProjectRecords(home);

  return inTurn(home, async () => {
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
    // taking turns means no other run in this process is using them.
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
