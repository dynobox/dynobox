import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rm, rmdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {execa} from 'execa';

import {buildAntigravityArgs, parseAntigravityJson} from './antigravity.js';
import {mcpDeadline, McpHarnessError} from './mcpError.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import {isRecord} from './parsing.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';
import {isAtLeastVersion, parseVersion} from './version.js';

// Oldest release whose project-scoped MCP config was verified natively.
const MIN_VERSION = '1.2.11';

/**
 * Antigravity has no flag to ignore inherited MCP sources, so the run uses the
 * installed login only when no other MCP source could load beside the mocks.
 */
export async function runAntigravityWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const {input, servers, executable} = options;
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const cwd = input.workDir;
  const home = input.env.HOME ?? process.env.HOME;
  if (!home)
    throw new McpHarnessError(
      'configuration_failed',
      'Antigravity MCP mocking requires HOME to locate its config.',
    );
  await assertNoInheritedMcpSources(cwd, home);

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
  const version = parseVersion(probe.stdout);
  if (probe.failed || !isAtLeastVersion(version, MIN_VERSION))
    throw new McpHarnessError(
      'unsupported_version',
      `Antigravity MCP mocking requires ${MIN_VERSION} or newer (found ${version ?? 'unknown'}).`,
    );
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
        remaining(),
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
        parsed.errorMessage ?? 'Antigravity finished without a final message.',
      );
    for (const event of parsed.toolEvents) input.onToolEvent?.(event);
    return {
      harnessReady: true,
      output: {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        metadata: {mcpHarnessVersion: version},
      },
    };
  } finally {
    await Promise.all([
      rm(projectConfig, {force: true}).then(() =>
        // Keep the directory if the agent wrote other files into it.
        createdAgentsDir ? rmdir(dirname(projectConfig)).catch(() => {}) : {},
      ),
      rm(projectRecord, {force: true}),
    ]);
  }
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
    const config = join(directory, '.agents', 'mcp_config.json');
    if ((await readFile(config).catch(() => undefined)) !== undefined)
      throw inherited(config);
    directories.push(
      join(directory, '.agents', 'plugins'),
      join(directory, '.agents', 'agents'),
    );
    if (dirname(directory) === directory) break;
  }
  for (const directory of directories)
    if ((await readdir(directory).catch(() => [])).length > 0)
      throw inherited(directory);
}
