import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {compile, resolveConfigModule} from '@dynobox/sdk/compiler';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {loadDyno, normalizeLoadedModule} from './configLoader.js';
import {executeCli} from './execute.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-init');

function chTo(dir: string) {
  mkdirSync(dir, {recursive: true});
  process.chdir(dir);
}

describe('dynobox init', () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('writes a runnable mjs starter under dynobox/example.dyno.mjs by default', async () => {
    const dir = join(ROOT, 'mjs-default');
    chTo(dir);

    const result = await executeCli(['init']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created dynobox/example.dyno.mjs');

    const written = join(dir, 'dynobox/example.dyno.mjs');
    expect(existsSync(written)).toBe(true);

    // The starter parses through the same pipeline as user-authored files.
    const loaded = await loadDyno(written);
    const config = resolveConfigModule(normalizeLoadedModule(loaded));
    const ir = compile(config);
    expect(ir.name).toBe('example');
    expect(ir.scenarios).toHaveLength(1);
  });

  it('writes a YAML starter when --yaml is passed', async () => {
    const dir = join(ROOT, 'yaml');
    chTo(dir);

    const result = await executeCli(['init', '--yaml']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created dynobox/example.dyno.yaml');

    const written = join(dir, 'dynobox/example.dyno.yaml');
    expect(existsSync(written)).toBe(true);

    const loaded = await loadDyno(written);
    const config = resolveConfigModule(normalizeLoadedModule(loaded));
    expect(() => compile(config)).not.toThrow();
  });

  it('embeds the requested --harness id', async () => {
    const dir = join(ROOT, 'harness');
    chTo(dir);

    const result = await executeCli(['init', '--harness', 'codex']);
    expect(result.exitCode).toBe(0);

    const body = readFileSync(join(dir, 'dynobox/example.dyno.mjs'), 'utf8');
    expect(body).toContain("['codex']");
  });

  it('refuses to overwrite an existing starter without --force', async () => {
    const dir = join(ROOT, 'no-clobber');
    chTo(dir);
    mkdirSync(join(dir, 'dynobox'), {recursive: true});
    writeFileSync(join(dir, 'dynobox/example.dyno.mjs'), 'do not clobber');

    const result = await executeCli(['init']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('--force');

    const body = readFileSync(join(dir, 'dynobox/example.dyno.mjs'), 'utf8');
    expect(body).toBe('do not clobber');
  });

  it('overwrites when --force is passed', async () => {
    const dir = join(ROOT, 'force');
    chTo(dir);
    mkdirSync(join(dir, 'dynobox'), {recursive: true});
    writeFileSync(join(dir, 'dynobox/example.dyno.mjs'), 'old contents');

    const result = await executeCli(['init', '--force']);
    expect(result.exitCode).toBe(0);

    const body = readFileSync(join(dir, 'dynobox/example.dyno.mjs'), 'utf8');
    expect(body).not.toBe('old contents');
    expect(body).toContain('defineDyno');
  });
});
