import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {cachedCodexPluginServers} from './codexMcpPlugins.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dynobox-codex-cache-'));
  roots.push(home);
  const version = async (name: string, manifest: object = {}) => {
    const root = join(home, 'plugins', 'cache', 'market', 'fixture', name);
    await mkdir(join(root, '.codex-plugin'), {recursive: true});
    await writeFile(
      join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({name: 'fixture', ...manifest}),
    );
    return root;
  };
  return {home, version};
}

describe('cached Codex plugin metadata', () => {
  it('collects names from every version without exposing transport or credentials', async () => {
    const f = await fixture();
    for (const name of ['1', '2']) {
      const root = await f.version(name);
      await writeFile(
        join(root, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            [`server${name}`]: {
              url: 'https://PRIVATE_SENTINEL.invalid',
              headers: {Authorization: 'PRIVATE_SENTINEL'},
            },
          },
        }),
      );
    }
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual([
      'server1',
      'server2',
    ]);
  });

  it('includes default files, inline manifests and referenced files', async () => {
    const f = await fixture();
    const root = await f.version('1', {
      mcpServers: [{inline: {command: 'unused'}}, './extra.json'],
    });
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({mcpServers: {default: {}}}),
    );
    await writeFile(
      join(root, 'extra.json'),
      JSON.stringify({mcpServers: {extra: {}}}),
    );
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual([
      'default',
      'extra',
      'inline',
    ]);
  });

  it('reads flat server maps in default and referenced MCP files', async () => {
    const f = await fixture();
    const root = await f.version('1', {mcpServers: './extra.json'});
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({default: {url: 'https://PRIVATE_SENTINEL.invalid'}}),
    );
    await writeFile(
      join(root, 'extra.json'),
      JSON.stringify({extra: {command: 'unused'}}),
    );
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual([
      'default',
      'extra',
    ]);
  });

  it('accepts a skill-only cache and an absent installation', async () => {
    const f = await fixture();
    await f.version('1');
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual(
      [],
    );
    expect(await cachedCodexPluginServers(f.home, 'missing@market')).toEqual(
      [],
    );
  });

  it('recognizes a flat-map server named mcpServers', async () => {
    const f = await fixture();
    const root = await f.version('1');
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({mcpServers: {command: 'unused'}}),
    );
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual([
      'mcpServers',
    ]);
  });

  it('ignores malformed metadata that Codex could not load either', async () => {
    const f = await fixture();
    const root = await f.version('1');
    await writeFile(join(root, '.mcp.json'), 'not json');
    expect(await cachedCodexPluginServers(f.home, 'fixture@market')).toEqual(
      [],
    );
  });
});
