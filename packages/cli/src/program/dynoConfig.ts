import {readFile, stat} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';

export const DYNO_CONFIG_BASENAME = 'dyno.config.json';

export type DynoConfig = {
  ignoredDirectories: string[];
  /** Absolute path the config was loaded from, or undefined when none applied. */
  configPath?: string;
};

export type LoadDynoConfigOptions = {
  /**
   * Directory to look in for `dyno.config.json` when no explicit config path
   * is supplied. Checked once with no upward walk — config is tied to the
   * invocation directory, matching how a test runner resolves config.
   */
  searchFrom: string;
  /** Explicit config path passed by --config. */
  configPath?: string;
  /** Defaults to process.cwd(). Exposed for tests. */
  cwd?: string;
};

export class DynoConfigError extends Error {
  constructor(
    public readonly configPath: string,
    message: string,
  ) {
    super(`${configPath}: ${message}`);
    this.name = 'DynoConfigError';
  }
}

export async function loadDynoConfig(
  options: LoadDynoConfigOptions,
): Promise<DynoConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath =
    options.configPath === undefined
      ? await findDynoConfig(options.searchFrom)
      : resolveInputPath(options.configPath, cwd);

  if (configPath === undefined) return {ignoredDirectories: []};

  const body = await readConfig(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DynoConfigError(configPath, `Invalid JSON. ${message}`);
  }

  return {...parseDynoConfig(configPath, parsed), configPath};
}

async function findDynoConfig(searchFrom: string): Promise<string | undefined> {
  const candidate = join(resolve(searchFrom), DYNO_CONFIG_BASENAME);
  if ((await statOrUndefined(candidate))?.isFile() === true) {
    return candidate;
  }
  return undefined;
}

async function readConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new DynoConfigError(configPath, 'Config file not found.');
    }
    throw error;
  }
}

function parseDynoConfig(configPath: string, value: unknown): DynoConfig {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new DynoConfigError(configPath, 'Config must be a JSON object.');
  }

  for (const key of Object.keys(value)) {
    if (key !== 'ignoredDirectories') {
      throw new DynoConfigError(configPath, `Unknown config field "${key}".`);
    }
  }

  const ignoredDirectories = value.ignoredDirectories;
  if (ignoredDirectories === undefined) return {ignoredDirectories: []};
  if (!Array.isArray(ignoredDirectories)) {
    throw new DynoConfigError(
      configPath,
      'ignoredDirectories must be an array of strings.',
    );
  }

  return {
    ignoredDirectories: ignoredDirectories.map((entry, index) =>
      parseIgnoredDirectory(configPath, entry, index),
    ),
  };
}

function parseIgnoredDirectory(
  configPath: string,
  value: unknown,
  index: number,
): string {
  if (typeof value !== 'string') {
    throw new DynoConfigError(
      configPath,
      `ignoredDirectories[${index}] must be a string.`,
    );
  }

  const rawDirectory = value.trim().replace(/\\/g, '/');
  if (isAbsolute(rawDirectory)) {
    throw new DynoConfigError(
      configPath,
      `ignoredDirectories[${index}] must be a relative directory path.`,
    );
  }

  const directory = rawDirectory.replace(/^\/+|\/+$/g, '');
  if (directory.length === 0) {
    throw new DynoConfigError(
      configPath,
      `ignoredDirectories[${index}] must not be empty.`,
    );
  }
  if (directory.split('/').includes('..')) {
    throw new DynoConfigError(
      configPath,
      `ignoredDirectories[${index}] must be a relative directory path.`,
    );
  }

  return directory;
}

function resolveInputPath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

async function statOrUndefined(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
