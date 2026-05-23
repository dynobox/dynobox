import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {defineDyno} from '../authoring/defineDyno.js';
import type {DynoboxConfig, ScenarioInput} from '../types/config.js';

/** Convert a file URL into a platform-correct filesystem path. */
export function fsPath(url: URL): string {
  return fileURLToPath(url);
}

/** Resolve a path relative to a config module URL. */
export function fromUrl(baseUrl: string, path: string): string {
  const resolved = fsPath(new URL(path, baseUrl));
  if (path.endsWith('/.') && !resolved.endsWith('/.')) {
    return `${resolved.endsWith('/') ? resolved : `${resolved}/`}.`;
  }
  return resolved;
}

/** Quote a string for safe use as one POSIX shell argument. */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type Here = {
  path(path: string): string;
  q(path: string): string;
  fixtures(subpath?: string): string;
  defineDyno: typeof defineDyno;
};

/**
 * Build path helpers scoped to a config module URL, usually `import.meta.url`.
 *
 * `defineDyno` is a convention-aware wrapper around the top-level `defineDyno`:
 * any scenario that omits `fixtures` is auto-assigned the absolute path of the
 * adjacent `fixtures/` directory when it exists on disk. Authors who don't want
 * the convention should keep using the top-level `defineDyno` export.
 */
export function here(baseUrl: string): Here {
  const resolveFixtures = (subpath = 'fixtures'): string =>
    fromUrl(baseUrl, subpath);

  const hereDefineDyno = ((config: Parameters<typeof defineDyno>[0]) => {
    const defaultFixtures = resolveFixtures();
    if (!existsSync(defaultFixtures)) return defineDyno(config);
    const scenarios = config.scenarios.map((scenario: ScenarioInput) =>
      scenario.fixtures === undefined
        ? {...scenario, fixtures: defaultFixtures}
        : scenario,
    );
    return defineDyno({
      ...config,
      scenarios,
    } as Parameters<typeof defineDyno>[0]) as DynoboxConfig;
  }) as typeof defineDyno;

  return {
    path(path: string): string {
      return fromUrl(baseUrl, path);
    },
    q(path: string): string {
      return shellQuote(fromUrl(baseUrl, path));
    },
    fixtures: resolveFixtures,
    defineDyno: hereDefineDyno,
  };
}

/** Namespace object exported for config authors as `dyno`. */
export const dyno = {
  fromUrl,
  fsPath,
  here,
  q: shellQuote,
  shellQuote,
};
