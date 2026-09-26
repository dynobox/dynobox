import {randomUUID} from 'node:crypto';
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {execa} from 'execa';

import {buildAntigravityArgs, parseAntigravityJson} from './antigravity.js';
import {mcpProxyEnv} from './mcpProxyEnv.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './types.js';

export class AntigravityMcpError extends Error {
  constructor(
    readonly category:
      | 'configuration_failed'
      | 'unsupported_version'
      | 'not_ready'
      | 'execution_failed'
      | 'cleanup_failed',
  ) {
    super(`Antigravity MCP ${category}.`);
    this.name = 'AntigravityMcpError';
  }
}

/** Use the installed login only when no inherited MCP source can be loaded. */
export async function runAntigravityWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<{output: HarnessRunOutput; harnessReady: true}> {
  const started = Date.now();
  const input = options.input;
  const timeout = input.timeoutMs ?? 120_000;
  const remaining = () => {
    const value = timeout - (Date.now() - started);
    if (value <= 0 || input.signal?.aborted)
      throw new AntigravityMcpError('execution_failed');
    return value;
  };
  if (
    !isAbsolute(options.executable) ||
    options.extraArgs?.length ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    !input.prompt ||
    /^[-@]/.test(input.prompt) ||
    input.prompt.includes('\0') ||
    (input.model !== undefined &&
      (!input.model || /^[-\s]|\0/.test(input.model))) ||
    !Object.keys(options.servers).length
  )
    throw new AntigravityMcpError('configuration_failed');
  for (const connection of Object.values(options.servers)) {
    let url: URL;
    try {
      url = new URL(connection.url);
    } catch {
      throw new AntigravityMcpError('configuration_failed');
    }
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
      throw new AntigravityMcpError('configuration_failed');
  }
  for (const grant of input.allowedMcpTools ?? []) {
    if (
      !Object.hasOwn(options.servers, grant.server) ||
      !options.servers[grant.server]!.tools.includes(grant.tool)
    )
      throw new AntigravityMcpError('configuration_failed');
  }

  const cwd = await realpath(input.workDir);
  const home = input.env.HOME ?? process.env.HOME;
  if (!home || !isAbsolute(home))
    throw new AntigravityMcpError('configuration_failed');
  const globalConfig = join(home, '.gemini', 'config', 'mcp_config.json');
  const legacyConfig = join(home, '.gemini', 'settings.json');
  const globalSettings = join(home, '.gemini', 'config', 'config.json');
  const projectConfig = join(cwd, '.agents', 'mcp_config.json');
  const projectId = randomUUID();
  const projectDir = join(home, '.gemini', 'config', 'projects');
  const projectRecord = join(projectDir, `${projectId}.json`);
  for (const path of [globalConfig, legacyConfig, globalSettings]) {
    const source = await readOptional(path);
    if (source === undefined || source.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new AntigravityMcpError('configuration_failed');
    }
    if (
      !isRecord(parsed) ||
      (parsed.mcpServers !== undefined &&
        (!isRecord(parsed.mcpServers) ||
          Object.keys(parsed.mcpServers).length !== 0))
    )
      throw new AntigravityMcpError('configuration_failed');
  }
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (
      (await exists(join(directory, '.agents', 'mcp_config.json'))) ||
      (await hasEntries(join(directory, '.agents', 'plugins'))) ||
      (await hasEntries(join(directory, '.agents', 'agents')))
    )
      throw new AntigravityMcpError('configuration_failed');
    if (dirname(directory) === directory) break;
  }
  for (const directory of [
    join(home, '.gemini', 'config', 'plugins'),
    join(home, '.gemini', 'antigravity-cli', 'plugins'),
    join(home, '.gemini', 'config', 'agents'),
    join(home, '.gemini', 'antigravity-cli', 'agents'),
  ]) {
    if (await hasEntries(directory))
      throw new AntigravityMcpError('configuration_failed');
  }

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
  if (version.failed || harnessVersion !== '1.2.11')
    throw new AntigravityMcpError('unsupported_version');
  const plugins = await execa(executable, ['plugin', 'list'], {
    ...processOptions,
    timeout: Math.min(5000, remaining()),
  });
  if (plugins.failed || plugins.stdout.trim() !== 'No imported plugins.')
    throw new AntigravityMcpError('configuration_failed');

  const mcpServers = Object.fromEntries(
    Object.entries(options.servers).map(([name, server]) => [
      name,
      {serverUrl: server.url},
    ]),
  );
  let createdProject = false;
  let createdMcp = false;
  let failure: AntigravityMcpError | undefined;
  let output: HarnessRunOutput | undefined;
  try {
    await mkdir(projectDir, {recursive: true});
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
      {flag: 'wx', mode: 0o600},
    );
    createdProject = true;
    await mkdir(join(cwd, '.agents'), {recursive: true});
    await writeFile(projectConfig, JSON.stringify({mcpServers}), {
      flag: 'wx',
      mode: 0o600,
    });
    createdMcp = true;
    const result = await execa(
      executable,
      buildAntigravityArgs(
        cwd,
        input.prompt,
        [],
        input.model,
        input.permissionMode,
        remaining(),
        projectId,
      ),
      {...processOptions, timeout: remaining()},
    );
    remaining();
    if (result.failed) throw new AntigravityMcpError('execution_failed');
    const parsed = parseAntigravityJson(result.stdout);
    if (parsed.terminalFailure || !parsed.finalMessage)
      throw new AntigravityMcpError('execution_failed');
    for (const event of parsed.toolEvents) input.onToolEvent?.(event);
    output = {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      metadata: {mcpHarnessVersion: harnessVersion},
    };
  } catch (error) {
    failure =
      error instanceof AntigravityMcpError
        ? error
        : new AntigravityMcpError('execution_failed');
  } finally {
    if (createdMcp) {
      try {
        await rm(projectConfig);
      } catch {
        failure = new AntigravityMcpError('cleanup_failed');
      }
    }
    if (createdProject) {
      try {
        await rm(projectRecord);
      } catch {
        failure = new AntigravityMcpError('cleanup_failed');
      }
    }
  }
  if (failure) throw failure;
  return {output: output!, harnessReady: true};
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new AntigravityMcpError('configuration_failed');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new AntigravityMcpError('configuration_failed');
  }
}

async function hasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new AntigravityMcpError('configuration_failed');
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
