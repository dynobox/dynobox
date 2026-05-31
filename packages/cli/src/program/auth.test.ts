import {mkdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {
  authConfigPath,
  DYNOBOX_CONFIG_MODE,
  resolveAuthToken,
  writeAuthConfig,
} from './auth.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-auth');

function homeDir(name: string): string {
  return join(ROOT, name);
}

function writeConfig(home: string, body: string): void {
  const filePath = authConfigPath({homeDir: home});
  mkdirSync(join(home, '.dynobox'), {recursive: true});
  writeFileSync(filePath, body);
}

describe('CLI auth config', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('prefers DYNOBOX_TOKEN over config file token', () => {
    const home = homeDir('env-precedence');
    writeConfig(home, JSON.stringify({token: 'config-token'}));

    expect(
      resolveAuthToken({
        env: {DYNOBOX_TOKEN: ' env-token '},
        homeDir: home,
      }),
    ).toBe('env-token');
  });

  it('falls back to ~/.dynobox/config.json when env token is absent', () => {
    const home = homeDir('config-fallback');
    writeConfig(home, JSON.stringify({token: ' config-token '}));

    expect(resolveAuthToken({env: {}, homeDir: home})).toBe('config-token');
  });

  it('returns null when no token source exists', () => {
    expect(resolveAuthToken({env: {}, homeDir: homeDir('missing')})).toBeNull();
  });

  it('returns null for malformed config JSON', () => {
    const home = homeDir('malformed-json');
    writeConfig(home, 'not json');

    expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
  });

  it('returns null for missing, empty, or non-string config tokens', () => {
    const cases: Array<[string, string]> = [
      ['missing-token', '{}'],
      ['empty-token', JSON.stringify({token: '   '})],
      ['number-token', JSON.stringify({token: 123})],
    ];

    for (const [name, body] of cases) {
      const home = homeDir(name);
      writeConfig(home, body);
      expect(resolveAuthToken({env: {}, homeDir: home})).toBeNull();
    }
  });

  it('writes config files with 0o600 permissions', () => {
    const home = homeDir('write-config');
    const filePath = writeAuthConfig({token: 'saved-token', homeDir: home});

    expect(resolveAuthToken({env: {}, homeDir: home})).toBe('saved-token');
    expect(statSync(filePath).mode & 0o777).toBe(DYNOBOX_CONFIG_MODE);
  });
});
