import {mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {discoverDynos, DynoPathNotFoundError} from './discoverDynos.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-discover');

function touch(relPath: string, body = ''): string {
  const absolute = join(ROOT, relPath);
  const lastSep = absolute.lastIndexOf('/');
  if (lastSep > 0) mkdirSync(absolute.slice(0, lastSep), {recursive: true});
  writeFileSync(absolute, body);
  return absolute;
}

describe('discoverDynos', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('returns a single file verbatim, even when the suffix is non-standard', async () => {
    const file = touch('legacy/dynobox.config.ts', 'export default {};');
    const result = await discoverDynos(file);
    expect(result).toEqual([file]);
  });

  it('finds *.dyno.{mjs,ts,yaml,yml} recursively and sorts them', async () => {
    const dir = join(ROOT, 'tree');
    mkdirSync(dir, {recursive: true});
    const a = touch('tree/a.dyno.mjs');
    const b = touch('tree/nested/b.dyno.ts');
    const c = touch('tree/nested/deeper/c.dyno.yaml');
    const d = touch('tree/d.dyno.yml');
    // Files that should NOT be picked up:
    touch('tree/not-a-dyno.mjs');
    touch('tree/dyno.mjs'); // wrong shape — not "<name>.dyno.mjs"

    const result = await discoverDynos(dir);
    expect(result).toEqual([a, d, c, b].slice().sort());
  });

  it('honors the default ignore list (node_modules, dist, .git, .dynobox)', async () => {
    const dir = join(ROOT, 'ignored');
    mkdirSync(dir, {recursive: true});
    touch('ignored/node_modules/pkg/x.dyno.mjs');
    touch('ignored/dist/y.dyno.mjs');
    touch('ignored/.git/z.dyno.mjs');
    touch('ignored/.dynobox/w.dyno.mjs');
    const kept = touch('ignored/keep.dyno.mjs');

    const result = await discoverDynos(dir);
    expect(result).toEqual([kept]);
  });

  it('honors ignoredDirectories from the nearest dyno.config.json', async () => {
    const dir = join(ROOT, 'configured/project/tests');
    mkdirSync(dir, {recursive: true});
    touch(
      'configured/project/dyno.config.json',
      JSON.stringify({ignoredDirectories: ['generated']}),
    );
    touch('configured/project/tests/generated/skip.dyno.mjs');
    const kept = touch('configured/project/tests/keep.dyno.mjs');

    const result = await discoverDynos(dir);
    expect(result).toEqual([kept]);
  });

  it('uses an explicit config path when provided', async () => {
    const dir = join(ROOT, 'explicit-config/tests');
    mkdirSync(dir, {recursive: true});
    const config = touch(
      'explicit-config/settings/dyno.config.json',
      JSON.stringify({ignoredDirectories: ['fixtures/generated']}),
    );
    touch('explicit-config/tests/fixtures/generated/skip.dyno.mjs');
    const kept = touch('explicit-config/tests/fixtures/keep.dyno.mjs');

    const result = await discoverDynos(dir, {configPath: config});
    expect(result).toEqual([kept]);
  });

  it('rejects invalid dyno.config.json shape', async () => {
    const dir = join(ROOT, 'invalid-config');
    mkdirSync(dir, {recursive: true});
    touch(
      'invalid-config/dyno.config.json',
      JSON.stringify({ignoredDirectories: 'generated'}),
    );
    touch('invalid-config/keep.dyno.mjs');

    await expect(discoverDynos(dir)).rejects.toThrow(
      'ignoredDirectories must be an array of strings',
    );
  });

  it('searches an explicitly provided hidden directory root', async () => {
    const dir = join(ROOT, '.agents/skills');
    mkdirSync(dir, {recursive: true});
    const file = touch('.agents/skills/demo/demo.dyno.mjs');

    const result = await discoverDynos(dir);
    expect(result).toEqual([file]);
  });

  it('discovers dynos in hidden AI skill directories below the search root', async () => {
    const dir = join(ROOT, 'hidden-descendants');
    mkdirSync(dir, {recursive: true});
    const kept = touch('hidden-descendants/skill/skill.dyno.mjs');
    const agent = touch('hidden-descendants/.agents/skills/agent.dyno.mjs');
    const claude = touch('hidden-descendants/.claude/skills/claude.dyno.yaml');

    const result = await discoverDynos(dir);
    expect(result).toEqual([kept, agent, claude].slice().sort());
  });

  it('still skips generated hidden directories below the search root', async () => {
    const dir = join(ROOT, 'generated-hidden-descendants');
    mkdirSync(dir, {recursive: true});
    touch('generated-hidden-descendants/.cache/cache.dyno.mjs');
    touch('generated-hidden-descendants/.git/git.dyno.mjs');
    touch('generated-hidden-descendants/.dynobox/artifact.dyno.mjs');
    touch('generated-hidden-descendants/.next/page.dyno.mjs');
    const kept = touch('generated-hidden-descendants/keep.dyno.mjs');

    const result = await discoverDynos(dir);
    expect(result).toEqual([kept]);
  });

  it('skips generated hidden directories below an explicitly provided hidden root', async () => {
    const dir = join(ROOT, '.agents/hidden-descendants');
    mkdirSync(dir, {recursive: true});
    const kept = touch('.agents/hidden-descendants/skill/skill.dyno.mjs');
    touch('.agents/hidden-descendants/.cache/cache.dyno.mjs');
    touch('.agents/hidden-descendants/skill/.hidden/hidden.dyno.mjs');

    const result = await discoverDynos(dir);
    expect(result).toEqual(
      [kept, join(dir, 'skill/.hidden/hidden.dyno.mjs')].sort(),
    );
  });

  it('returns an empty list for an empty directory', async () => {
    const dir = join(ROOT, 'empty');
    mkdirSync(dir, {recursive: true});

    await expect(discoverDynos(dir)).resolves.toEqual([]);
  });

  it('throws DynoPathNotFoundError when the path does not exist', async () => {
    await expect(
      discoverDynos(join(ROOT, 'does-not-exist')),
    ).rejects.toBeInstanceOf(DynoPathNotFoundError);
  });

  it('does not follow symlinks back into itself', async () => {
    const dir = join(ROOT, 'symlinked');
    mkdirSync(dir, {recursive: true});
    const real = touch('symlinked/a.dyno.mjs');
    // Create a symlink that points to its own ancestor — would loop if we
    // followed symbolic links during traversal.
    try {
      symlinkSync(dir, join(dir, 'self'));
    } catch {
      // Filesystems that disallow symlinks (e.g. CI on Windows) skip this.
      return;
    }

    const result = await discoverDynos(dir);
    expect(result).toEqual([real]);
  });

  it('defaults the target to the cwd option when no path is supplied', async () => {
    const dir = join(ROOT, 'default-cwd');
    mkdirSync(dir, {recursive: true});
    const file = touch('default-cwd/sample.dyno.mjs');

    const result = await discoverDynos(undefined, {cwd: dir});
    expect(result).toEqual([file]);
  });
});
