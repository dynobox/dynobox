import {fileURLToPath} from 'node:url';

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
};

/**
 * Build path helpers scoped to a config module URL, usually `import.meta.url`.
 */
export function here(baseUrl: string): Here {
  const resolveFixtures = (subpath?: string): string =>
    fromUrl(
      baseUrl,
      subpath === undefined ? 'fixtures' : `fixtures/${subpath}`,
    );

  return {
    path(path: string): string {
      return fromUrl(baseUrl, path);
    },
    q(path: string): string {
      return shellQuote(fromUrl(baseUrl, path));
    },
    fixtures: resolveFixtures,
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
