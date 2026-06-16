import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-discoverCommand');

function touch(relPath: string, body = ''): string {
  const absolute = join(ROOT, relPath);
  const lastSep = absolute.lastIndexOf('/');
  if (lastSep > 0) mkdirSync(absolute.slice(0, lastSep), {recursive: true});
  writeFileSync(absolute, body);
  return absolute;
}

function displayPath(filePath: string): string {
  return relative(process.cwd(), filePath) || filePath;
}

describe('dynobox discover', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('prints discovered dyno files in run order', async () => {
    const dir = join(ROOT, 'tree');
    mkdirSync(dir, {recursive: true});
    const a = touch('tree/a.dyno.mjs');
    const b = touch('tree/nested/b.dyno.yaml');
    touch('tree/not-a-dyno.mjs');

    const result = await executeCli(['discover', dir]);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        [a, b]
          .sort()
          .map((filePath) => displayPath(filePath))
          .join('\n') + '\n',
      stderr: '',
    });
  });

  it('prints an explicit file path even when it is not named *.dyno.*', async () => {
    const file = touch('legacy/dynobox.config.ts', 'export default {};');

    const result = await executeCli(['discover', file]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${displayPath(file)}\n`,
      stderr: '',
    });
  });

  it('honors --config when discovering dyno files', async () => {
    const dir = join(ROOT, 'configured-tree');
    mkdirSync(dir, {recursive: true});
    const config = touch(
      'configured-settings/dyno.config.json',
      JSON.stringify({ignoredDirectories: ['generated']}),
    );
    touch('configured-tree/generated/skip.dyno.mjs');
    const kept = touch('configured-tree/keep.dyno.mjs');

    const result = await executeCli(['discover', dir, '--config', config]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${displayPath(kept)}\n`,
      stderr: '',
    });
  });

  it('prints nothing for an empty directory', async () => {
    const dir = join(ROOT, 'empty');
    mkdirSync(dir, {recursive: true});

    const result = await executeCli(['discover', dir]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('exits nonzero when discovery fails', async () => {
    const missingPath = join(ROOT, 'missing');

    const result = await executeCli(['discover', missingPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('dynobox discover');
    expect(result.stderr).toContain(`config: ${missingPath}`);
    expect(result.stderr).toContain('Path not found');
  });
});
