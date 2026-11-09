import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {readMcpJsonConfig} from './config.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});
const messages = {read: 'Cannot read profile.', parse: 'Invalid profile.'};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-mcp-config-'));
  roots.push(root);
  return {root, path: join(root, 'config.json')};
}

describe('native MCP JSONC configuration', () => {
  it('accepts empty files only when the adapter opts in', async () => {
    const {path} = await fixture();
    await writeFile(path, ' \n\t');
    await expect(readMcpJsonConfig(path, messages)).rejects.toMatchObject({
      category: 'configuration_failed',
      message: messages.parse,
    });
    expect(
      await readMcpJsonConfig(path, {...messages, allowEmpty: true}),
    ).toEqual({});
  });

  it('treats missing files as empty and accepts comments and trailing commas', async () => {
    const {path} = await fixture();
    expect(await readMcpJsonConfig(path, messages)).toEqual({});
    await writeFile(
      path,
      '{/* native profile */ "mcpServers": {"linear": {}},}',
    );
    expect(await readMcpJsonConfig(path, messages)).toEqual({
      mcpServers: {linear: {}},
    });
  });

  it.each(['{"private":', '[]', 'null'])(
    'rejects invalid configuration without exposing its contents (%s)',
    async (source) => {
      const {path} = await fixture();
      await writeFile(path, source);
      await expect(readMcpJsonConfig(path, messages)).rejects.toMatchObject({
        category: 'configuration_failed',
        message: messages.parse,
      });
    },
  );

  it('preserves adapter-specific read diagnostics and optional original errors', async () => {
    const {root} = await fixture();
    await expect(readMcpJsonConfig(root, messages)).rejects.toMatchObject({
      category: 'configuration_failed',
      message: messages.read,
    });
    await expect(
      readMcpJsonConfig(root, {parse: messages.parse}),
    ).rejects.toMatchObject({code: 'EISDIR'});
  });
});
