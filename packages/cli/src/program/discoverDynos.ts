/**
 * Find the set of dyno files to run, given an optional file or directory
 * path supplied on the command line.
 *
 * The CLI's `run` subcommand accepts:
 *   - no path           → discover under the current working directory
 *   - a directory path  → discover under that directory (recursive)
 *   - a file path       → run that single file
 *
 * Discovery globs `**\/*.dyno.{mjs,js,ts,mts,yaml,yml}` and skips a default
 * set of generated directories that should never contain authored tests.
 * Existing config files passed by absolute or relative path (the legacy
 * `dynobox run skills/.../dynobox.config.ts` form) keep working — file
 * inputs are returned verbatim regardless of the `.dyno.*` suffix so that
 * authored config paths remain valid during the transition.
 */

import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';

import {glob} from 'tinyglobby';

import {resolveInputPath, statOrUndefined} from '../util/fsx.js';
import {loadDynoConfig} from './dynoConfig.js';

/**
 * Filename patterns that count as authored dyno files.
 *
 * `.cjs` and `.cts` are intentionally excluded: `@dynobox/sdk` is
 * ESM-only (its `exports` map has no `"require"` condition), so a
 * CommonJS config that calls `require('@dynobox/sdk')` fails at load
 * time. Authors who want a CJS-flavored project still get TypeScript
 * (`.ts`/`.mts`) or vanilla ESM (`.mjs`/`.js`).
 */
export const DYNO_FILE_GLOBS = [
  '**/*.dyno.mjs',
  '**/*.dyno.js',
  '**/*.dyno.ts',
  '**/*.dyno.mts',
  '**/*.dyno.yaml',
  '**/*.dyno.yml',
] as const;

/** Generated directories never traversed during discovery. */
export const DYNO_DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.dynobox/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.cache/**',
] as const;

const DYNO_DISCOVERED_DOT_DIRECTORIES = ['.agents', '.claude'] as const;

/** Thrown when discovery is asked to look at a path that does not exist. */
export class DynoPathNotFoundError extends Error {
  constructor(public readonly inputPath: string) {
    super(`Path not found: ${inputPath}`);
    this.name = 'DynoPathNotFoundError';
  }
}

/**
 * Comma-joined list of extensions derived from `DYNO_FILE_GLOBS`, e.g.
 * `mjs,js,ts,mts,yaml,yml`. Used in user-facing error messages so the
 * advertised set can't drift away from the glob.
 */
export const DYNO_FILE_SUFFIXES = DYNO_FILE_GLOBS.map((g) =>
  g.replace('**/*.dyno.', ''),
).join(',');

export type DiscoverDynosOptions = {
  /** Defaults to `process.cwd()`. Exposed for tests. */
  cwd?: string;
  /** Explicit dyno.config.json path passed by --config. */
  configPath?: string;
};

export type DiscoverDynosResult = {
  /** Sorted, absolute dyno file paths. */
  files: string[];
  /** Absolute path of the `dyno.config.json` that applied, if any. */
  configPath?: string;
};

/**
 * Resolve an optional CLI path argument to an absolute list of dyno files
 * to load and run.
 *
 * @param inputPath  File or directory; `undefined` means "current dir".
 * @returns          Sorted, absolute file paths plus the config that applied.
 */
export async function discoverDynos(
  inputPath: string | undefined,
  options: DiscoverDynosOptions = {},
): Promise<DiscoverDynosResult> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteInputPath = resolveInputPath(inputPath ?? '.', cwd);

  const stats = await statOrUndefined(absoluteInputPath);
  if (stats === undefined) {
    throw new DynoPathNotFoundError(inputPath ?? '.');
  }

  if (stats.isFile()) {
    // Legacy/explicit file path: return as-is so authored configs keep
    // working even when their filename does not match `*.dyno.*`.
    return {files: [absoluteInputPath]};
  }

  if (!stats.isDirectory()) {
    throw new DynoPathNotFoundError(inputPath ?? '.');
  }

  const config = await loadDynoConfig({
    searchFrom: cwd,
    ...(options.configPath === undefined
      ? {}
      : {configPath: options.configPath}),
    cwd,
  });
  const configuredIgnore = ignoredDirectoryGlobs(config, absoluteInputPath);
  if (configuredIgnore === undefined) {
    return {
      files: [],
      ...(config.configPath === undefined
        ? {}
        : {configPath: config.configPath}),
    };
  }
  const ignore = [...DYNO_DEFAULT_IGNORE, ...configuredIgnore];

  const matches = await discoverMatches(absoluteInputPath, ignore);

  return {
    files: matches.slice().sort(),
    ...(config.configPath === undefined ? {} : {configPath: config.configPath}),
  };
}

async function discoverMatches(
  searchRoot: string,
  ignore: readonly string[],
): Promise<string[]> {
  const visibleMatches = await glob(DYNO_FILE_GLOBS as unknown as string[], {
    cwd: searchRoot,
    absolute: true,
    ignore: ignore as unknown as string[],
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  const allowedDotMatches = await glob(discoveredDotDirectoryGlobs(), {
    cwd: searchRoot,
    absolute: true,
    dot: true,
    ignore: [...ignore, '**/.!(agents|claude)/**'],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  return Array.from(new Set([...visibleMatches, ...allowedDotMatches]));
}

function discoveredDotDirectoryGlobs(): string[] {
  return [
    ...DYNO_DISCOVERED_DOT_DIRECTORIES.flatMap((directory) =>
      DYNO_FILE_GLOBS.map((glob) => glob.replace('**/', `**/${directory}/**/`)),
    ),
  ];
}

function ignoredDirectoryGlobs(
  config: {configPath?: string; ignoredDirectories: readonly string[]},
  searchRoot: string,
): string[] | undefined {
  if (config.configPath === undefined) return [];

  const configDir = dirname(config.configPath);
  const globs: string[] = [];
  for (const directory of config.ignoredDirectories) {
    const ignoredDirectory = resolve(configDir, directory);
    if (isEqualOrDescendant(ignoredDirectory, searchRoot)) return undefined;
    if (isEqualOrDescendant(searchRoot, ignoredDirectory)) {
      globs.push(
        `${toIgnoredDirectoryGlob(relative(searchRoot, ignoredDirectory))}/**`,
      );
    }
  }
  return globs;
}

function isEqualOrDescendant(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function toIgnoredDirectoryGlob(path: string): string {
  return path.replace(/\\/g, '/').replace(/[!*+?()[\]{}@]/g, '\\$&');
}
