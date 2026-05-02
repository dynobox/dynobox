export function fsPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

export function fromUrl(baseUrl: string, path: string): string {
  const resolved = fsPath(new URL(path, baseUrl));
  if (path.endsWith('/.') && !resolved.endsWith('/.')) {
    return `${resolved.endsWith('/') ? resolved : `${resolved}/`}.`;
  }
  return resolved;
}

export function shellQuote(value: string): string {
  return JSON.stringify(value);
}

export function here(baseUrl: string): {
  path(path: string): string;
  q(path: string): string;
} {
  return {
    path(path: string): string {
      return fromUrl(baseUrl, path);
    },
    q(path: string): string {
      return shellQuote(fromUrl(baseUrl, path));
    },
  };
}

export const dyno = {
  fromUrl,
  fsPath,
  here,
  q: shellQuote,
  shellQuote,
};
