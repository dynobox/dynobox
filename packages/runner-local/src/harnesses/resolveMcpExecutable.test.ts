import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, expect, it} from 'vitest';

import {resolveMcpExecutable} from './resolveMcpExecutable.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

it('keeps a symlinked shim path so multicall shims still dispatch', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dynobox-resolve-mcp-')),
  );
  roots.push(root);
  const bin = join(root, 'shims');
  await mkdir(bin);
  await writeFile(join(root, 'mise'), '#!/bin/sh\n', {mode: 0o755});
  await symlink(join(root, 'mise'), join(bin, 'claude'));
  expect(
    await resolveMcpExecutable('claude', {workDir: root, env: {PATH: bin}}),
  ).toEqual({executable: join(bin, 'claude'), workDir: root});
});
