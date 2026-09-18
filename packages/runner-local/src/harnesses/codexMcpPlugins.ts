import {readdir, readFile, realpath, stat} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

import {isRecord} from './parsing.js';

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_VERSIONS = 100;

/**
 * Codex can load cached enabled plugins absent from plugin/list. Collect names
 * from every cached version; do not reproduce its version-selection algorithm.
 * Never return transports, credentials, skill contents, or raw parse errors.
 */
export async function cachedCodexPluginServers(
  codexHome: string,
  id: string,
): Promise<string[]> {
  try {
    const parts = id.split('@');
    if (
      parts.length !== 2 ||
      !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
    )
      throw new Error();
    const cache = join(codexHome, 'plugins', 'cache', parts[1]!, parts[0]!);
    let versions;
    try {
      versions = await readdir(cache, {withFileTypes: true});
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    if (versions.length > MAX_VERSIONS) throw new Error();
    const names = new Set<string>();
    for (const version of versions) {
      if (!version.isDirectory() && !version.isSymbolicLink())
        throw new Error();
      const root = await realpath(join(cache, version.name));
      const json = async (path: string, optional = false): Promise<unknown> => {
        let target: string;
        try {
          target = await realpath(path);
        } catch (error) {
          if (optional && isRecord(error) && error.code === 'ENOENT')
            return undefined;
          throw error;
        }
        const local = relative(root, target);
        if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
          throw new Error();
        const info = await stat(target);
        if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw new Error();
        return JSON.parse(await readFile(target, 'utf8'));
      };
      const add = (value: unknown) => {
        if (!isRecord(value)) throw new Error();
        for (const name of Object.keys(value)) {
          if (!name || /[\0\r\n]/.test(name)) throw new Error();
          names.add(name);
        }
      };
      const file = async (path: string, optional = false) => {
        const value = await json(path, optional);
        if (optional && value === undefined) return;
        if (!isRecord(value)) throw new Error();
        const wrapped =
          isRecord(value.mcpServers) &&
          Object.values(value.mcpServers).every(isRecord);
        add(wrapped ? value.mcpServers : value);
      };
      const manifest = await json(join(root, '.codex-plugin', 'plugin.json'));
      if (!isRecord(manifest)) throw new Error();
      await file(join(root, '.mcp.json'), true);
      const metadata = manifest.mcpServers;
      if (metadata === undefined) continue;
      const entries = Array.isArray(metadata) ? metadata : [metadata];
      for (const entry of entries) {
        if (typeof entry === 'string') await file(resolve(root, entry));
        else add(entry);
      }
    }
    return [...names].sort();
  } catch {
    throw new Error('Codex cached plugin metadata is not supported.');
  }
}
