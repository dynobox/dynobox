import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {authConfigPath, writeAuthConfig} from './auth.js';
import {executeCli} from './execute.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-logout');

function homeDir(name: string): string {
  return join(ROOT, name);
}

describe('dynobox logout', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('removes a saved token and reports the path', async () => {
    const home = homeDir('saved-token');
    writeAuthConfig({homeDir: home, token: 'saved-token'});

    const result = await executeCli(['logout'], {env: {HOME: home}});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Removed saved token from ~/.dynobox/config.json\n',
    );
    expect(result.stderr).toBe('');
    expect(existsSync(authConfigPath({homeDir: home}))).toBe(false);
  });

  it('reports when there is no saved token', async () => {
    const result = await executeCli(['logout'], {
      env: {HOME: homeDir('never-logged-in')},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'Not logged in; no saved token at ~/.dynobox/config.json\n',
    );
    expect(result.stderr).toBe('');
  });

  it('warns that DYNOBOX_TOKEN is still active after removing the file', async () => {
    const home = homeDir('env-token-still-set');
    writeAuthConfig({homeDir: home, token: 'saved-token'});

    const result = await executeCli(['logout'], {
      env: {DYNOBOX_TOKEN: 'env-token', HOME: home},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Removed saved token from ~/.dynobox/config.json',
    );
    expect(result.stdout).toContain('DYNOBOX_TOKEN is still set');
    expect(result.stderr).toBe('');
  });
});
