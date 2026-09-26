import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {isRecord} from './parsing.js';

/**
 * Codex can load cached enabled plugins absent from plugin/list. Collect
 * server names from every cached version rather than reproducing its
 * version-selection algorithm.
 */
export async function cachedCodexPluginServers(
  codexHome: string,
  id: string,
): Promise<string[]> {
  const [name, marketplace] = id.split('@');
  if (!name || !marketplace) return [];
  const cache = join(codexHome, 'plugins', 'cache', marketplace, name);
  const versions = await readdir(cache).catch(() => [] as string[]);
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (isRecord(value)) for (const key of Object.keys(value)) names.add(key);
  };
  const addFile = async (path: string) => {
    const value: unknown = await readFile(path, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (!isRecord(value)) return;
    const wrapped =
      isRecord(value.mcpServers) &&
      Object.values(value.mcpServers).every(isRecord);
    add(wrapped ? value.mcpServers : value);
  };
  for (const version of versions) {
    const root = join(cache, version);
    await addFile(join(root, '.mcp.json'));
    const manifest: unknown = await readFile(
      join(root, '.codex-plugin', 'plugin.json'),
      'utf8',
    )
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    const metadata = isRecord(manifest) ? manifest.mcpServers : undefined;
    for (const entry of Array.isArray(metadata) ? metadata : [metadata]) {
      if (typeof entry === 'string') await addFile(resolve(root, entry));
      else add(entry);
    }
  }
  return [...names].sort();
}
