/**
 * Find the set of dyno files to run, given an optional file or directory
 * path supplied on the command line.
 *
 * The CLI's `run` subcommand accepts:
 *   - no path           → discover under the current working directory
 *   - a directory path  → discover under that directory (recursive)
 *   - a file path       → run that single file
 *
 * Discovery globs `**\/*.dyno.{mjs,js,ts,mts,yaml,yml}` and skips hidden
 * entries below the search root plus a default set of directories that should
 * never contain authored tests. Passing a hidden directory as the root still
 * searches inside that explicit root.
 * Existing config files passed by absolute or relative path (the legacy
 * `dynobox run examples/.../dynobox.config.ts` form) keep working — file
 * inputs are returned verbatim regardless of the `.dyno.*` suffix so that
 * authored config paths remain valid during the transition.
 */

import {stat} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';

import {glob} from 'tinyglobby';

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

/** Hidden entries and directories never traversed during discovery. */
export const DYNO_DEFAULT_IGNORE = [
  '**/.*',
  '**/.*/**',
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
export class DynoTargetNotFoundError extends Error {
  constructor(public readonly targetPath: string) {
    super(`Path not found: ${targetPath}`);
    this.name = 'DynoTargetNotFoundError';
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

/** Thrown when a directory contains no `*.dyno.*` files. */
export class NoDynosFoundError extends Error {
  constructor(public readonly directory: string) {
    super(`No *.dyno.{${DYNO_FILE_SUFFIXES}} files found under ${directory}`);
    this.name = 'NoDynosFoundError';
  }
}

export type DiscoverDynosOptions = {
  /** Defaults to `process.cwd()`. Exposed for tests. */
  cwd?: string;
};

/**
 * Resolve an optional CLI path argument to an absolute list of dyno files
 * to load and run.
 *
 * @param targetPath  File or directory; `undefined` means "current dir".
 * @returns           Sorted, absolute file paths.
 */
export async function discoverDynos(
  targetPath: string | undefined,
  options: DiscoverDynosOptions = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteTarget = resolveTarget(targetPath ?? '.', cwd);

  const stats = await statOrUndefined(absoluteTarget);
  if (stats === undefined) {
    throw new DynoTargetNotFoundError(targetPath ?? '.');
  }

  if (stats.isFile()) {
    // Legacy/explicit file path: return as-is so authored configs keep
    // working even when their filename does not match `*.dyno.*`.
    return [absoluteTarget];
  }

  if (!stats.isDirectory()) {
    throw new DynoTargetNotFoundError(targetPath ?? '.');
  }

  const matches = await glob(DYNO_FILE_GLOBS as unknown as string[], {
    cwd: absoluteTarget,
    absolute: true,
    dot: true,
    ignore: DYNO_DEFAULT_IGNORE as unknown as string[],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  if (matches.length === 0) {
    throw new NoDynosFoundError(absoluteTarget);
  }

  return matches.slice().sort();
}

function resolveTarget(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
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
