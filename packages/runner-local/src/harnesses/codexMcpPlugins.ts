import {readdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {isRecord} from './parsing.js';

/**
 * Get MCP server names from all cached versions of a plugin.
 *
 * Codex can use a cached plugin that is absent from the marketplace list.
 * Read all versions to include each possible server name.
 */
export async function cachedCodexPluginServers(
  codexHome: string,
  id: string,
): Promise<string[]> {
  const separator = id.lastIndexOf('@');
  if (separator <= 0 || separator === id.length - 1) return [];
  const name = id.slice(0, separator);
  const marketplace = id.slice(separator + 1);
  const cache = join(codexHome, 'plugins', 'cache', marketplace, name);
  const versions = await readdir(cache).catch(() => [] as string[]);
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (isRecord(value)) for (const key of Object.keys(value)) names.add(key);
  };
  /** Read a JSON file and add its server names to the set. */
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
