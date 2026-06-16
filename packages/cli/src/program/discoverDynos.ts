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
 * `dynobox run examples/.../dynobox.config.ts` form) keep working — file
 * inputs are returned verbatim regardless of the `.dyno.*` suffix so that
 * authored config paths remain valid during the transition.
 */

import {stat} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';

import {glob} from 'tinyglobby';

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
  const ignore = [
    ...DYNO_DEFAULT_IGNORE,
    ...config.ignoredDirectories.map(ignoredDirectoryGlob),
  ];

  const matches = await glob(DYNO_FILE_GLOBS as unknown as string[], {
    cwd: absoluteInputPath,
    absolute: true,
    dot: true,
    ignore: ignore as unknown as string[],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  return {
    files: matches.slice().sort(),
    ...(config.configPath === undefined ? {} : {configPath: config.configPath}),
  };
}

function resolveInputPath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

function ignoredDirectoryGlob(directory: string): string {
  return `**/${directory}/**`;
}

async function statOrUndefined(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
