import {mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {authConfigPath, DYNOBOX_CONFIG_MODE, resolveAuthToken} from './auth.js';
import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-login');

function homeDir(name: string): string {
  return join(ROOT, name);
}

describe('dynobox login', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('prints the CLI auth URL, reads a pasted token, and writes config', async () => {
    const home = homeDir('default-url');
    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => ' pasted-token\n',
    });

    const filePath = authConfigPath({homeDir: home});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('https://dash.dynobox.xyz/cli-auth');
    expect(result.stdout).toContain('Paste your Dynobox token:');
    expect(result.stdout).toContain('Saved token to ~/.dynobox/config.json');
    expect(result.stderr).toBe('');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      token: 'pasted-token',
    });
    expect(resolveAuthToken({env: {}, homeDir: home})).toBe('pasted-token');
    expect(statSync(filePath).mode & 0o777).toBe(DYNOBOX_CONFIG_MODE);
  });

  it('uses DYNOBOX_DASHBOARD_URL for development auth links', async () => {
    const home = homeDir('custom-url');
    const result = await executeCli(['login'], {
      env: {
        HOME: home,
        DYNOBOX_DASHBOARD_URL: 'http://localhost:5173/',
      },
      readStdin: async () => 'dev-token',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('http://localhost:5173/cli-auth');
  });

  it('rejects empty pasted tokens', async () => {
    const home = homeDir('empty-token');
    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => '   \n',
    });

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('error: token cannot be empty');
    expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
  });

  it('overwrites existing malformed config', async () => {
    const home = homeDir('overwrite-malformed');
    const filePath = authConfigPath({homeDir: home});
    mkdirSync(join(home, '.dynobox'), {recursive: true});
    writeFileSync(filePath, 'not json');

    const result = await executeCli(['login'], {
      env: {HOME: home},
      readStdin: async () => 'replacement-token',
    });

    expect(result.exitCode).toBe(0);
    expect(resolveAuthToken({env: {}, homeDir: home})).toBe(
      'replacement-token',
    );
    expect(statSync(filePath).mode & 0o777).toBe(DYNOBOX_CONFIG_MODE);
  });
});
