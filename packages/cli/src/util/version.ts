/**
 * Read this package's version from its `package.json` at runtime.
 *
 * The relative path from the JS file to the package root depends on whether
 * we're running source (`src/util/version.ts` via tsx, two levels deep) or
 * a `tsup`-flattened bundle (`dist/bin.js` or `dist/index.js`, one level
 * deep). We try both and pick the one whose `name` is `"dynobox"`.
 *
 * The result is cached after the first successful read.
 */

import {readFileSync} from 'node:fs';

const CANDIDATE_PATHS = ['../../package.json', '../package.json'] as const;

let cached: string | undefined;

export function readPackageVersion(): string {
  if (cached !== undefined) return cached;

  const errors: string[] = [];
  for (const candidate of CANDIDATE_PATHS) {
    const url = new URL(candidate, import.meta.url);
    try {
      const raw = readFileSync(url, 'utf8');
      const parsed = JSON.parse(raw) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name !== 'dynobox') continue;
      if (typeof parsed.version !== 'string') {
        throw new Error('dynobox package.json has a non-string "version"');
      }
      cached = parsed.version;
      return cached;
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Unable to locate dynobox package.json. Tried: ${errors.join('; ')}`,
  );
}
