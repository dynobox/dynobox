import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

import {afterEach, expect, it} from 'vitest';

import {resolveMcpExecutable} from './resolveMcpExecutable.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

it.each([false, true])(
  'skips a directory on PATH (symlink: %s)',
  async (linked) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'dynobox-resolve-mcp-')),
    );
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    if (linked) {
      const target = join(root, 'directory');
      await mkdir(target);
      await symlink(target, join(first, 'claude'));
    } else {
      await mkdir(join(first, 'claude'));
    }
    const executable = join(second, 'claude');
    await writeFile(executable, '#!/bin/sh\n', {mode: 0o755});
    expect(
      await resolveMcpExecutable('claude', {
        workDir: root,
        env: {PATH: [first, second].join(delimiter)},
      }),
    ).toEqual({executable, workDir: root});
  },
);

it('rejects a directory given as an explicit executable path', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dynobox-resolve-mcp-')),
  );
  roots.push(root);
  await expect(
    resolveMcpExecutable(root, {workDir: root, env: {}}),
  ).rejects.toThrow('Could not find');
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
