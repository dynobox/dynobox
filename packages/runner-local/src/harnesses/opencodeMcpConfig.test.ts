import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, expect, it} from 'vitest';

import {checkOpenCodeConfigReads} from './opencodeMcpConfig.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-config-'));
  roots.push(root);
  return {
    root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed'),
    },
  };
}

it('accepts JSONC comments and trailing commas without modifying the file', async () => {
  const {root, env} = await fixture();
  const path = join(root, 'opencode.jsonc');
  const source =
    '{\n// editor config\n"$schema": "https://opencode.ai/config.json",\n}';
  await writeFile(path, source);
  await checkOpenCodeConfigReads(root, env);
  expect(await readFile(path, 'utf8')).toBe(source);
});

it.each(['{}', '{"$schema":""}', '{"$schema":"{env:SCHEMA}"}', '{"$schema":'])(
  'rejects unsafe config before native loading: %s',
  async (source) => {
    const {root, env} = await fixture();
    const path = join(root, 'opencode.jsonc');
    await writeFile(path, source);
    await expect(checkOpenCodeConfigReads(root, env)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(source);
  },
);

it.each([
  'config/opencode/opencode.json',
  '.opencode/opencode.json',
  'managed/opencode.json',
  'config/opencode/config',
])('checks global, home, managed and legacy sources: %s', async (relative) => {
  const {root, env} = await fixture();
  const path = join(root, relative);
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, '{}');
  await expect(checkOpenCodeConfigReads(root, env)).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{}');
});
