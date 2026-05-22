import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {FakeHarness, type ShellToolEvent} from '@dynobox/runner-local';
import {compile, resolveConfigModule} from '@dynobox/sdk/compiler';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {loadDyno, normalizeLoadedModule} from './configLoader.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

/**
 * A harness that satisfies the assertions in the `dynobox init` starter
 * templates (both MJS and YAML). The starter expects: at least one
 * `shell` tool call referencing `package.json`, no `edit_file` calls,
 * a `package.json` artifact containing `echo ok` (provided by setup),
 * and a final message containing `test`.
 */
function createInitStarterHarness(): FakeHarness {
  const event: ShellToolEvent = {
    kind: 'shell',
    rawName: 'Bash',
    input: {command: 'cat package.json'},
    command: 'cat package.json',
  };
  // `FakeHarness.extractResult` derives both `transcript` and
  // `finalMessage` from `stdout`, so embedding the required `test`
  // substring there satisfies `finalMessage.contains('test')`.
  return new FakeHarness(
    {stdout: 'yes, this project has a test script'},
    {toolEvents: [event]},
  );
}

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

  it('rejects an unknown --harness id before writing a starter', async () => {
    const dir = join(ROOT, 'invalid-harness');
    chTo(dir);

    const result = await executeCli(['init', '--harness', 'nope']);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('Invalid harness "nope"');
    expect(existsSync(join(dir, 'dynobox/example.dyno.mjs'))).toBe(false);
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

  it('scaffolds an MJS starter that passes `dynobox run` end-to-end', async () => {
    const dir = join(ROOT, 'e2e-mjs');
    chTo(dir);

    const initResult = await executeCli(['init']);
    expect(initResult.exitCode).toBe(0);

    const runResult = await executeCli(['run'], {
      harnesses: [createInitStarterHarness()],
    });
    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain('inspects package.json');
    expect(runResult.stdout).toContain('1 passed');
  });

  it('scaffolds a YAML starter that passes `dynobox run` end-to-end', async () => {
    const dir = join(ROOT, 'e2e-yaml');
    chTo(dir);

    const initResult = await executeCli(['init', '--yaml']);
    expect(initResult.exitCode).toBe(0);

    const runResult = await executeCli(['run'], {
      harnesses: [createInitStarterHarness()],
    });
    expect(runResult.exitCode).toBe(0);
    expect(runResult.stdout).toContain('inspects package.json');
    expect(runResult.stdout).toContain('1 passed');
  });
});
