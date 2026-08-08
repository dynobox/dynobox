import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {installCliMockShims} from './shims.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {force: true, recursive: true});
  }
});

describe('installCliMockShims', () => {
  it('installs private support files and builds the child environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dynobox-cli-mock-shims-'));
    roots.push(root);
    const shims = await installCliMockShims(root, ['vitest']);

    const env = shims.env({
      socketPath: '/tmp/mock.sock',
      token: 'token',
      requestTimeoutMs: 20,
      basePath: '/usr/bin',
      baseScriptShell: '/bin/bash',
      baseEnv: {
        HOME: '/home/test',
        BASH_ENV: '/home/test/bash-env',
        ENV: '/home/test/posix-env',
      },
    });
    const binDir = join(root, 'bin');
    const shellDir = join(root, 'shell');

    expect(statSync(join(binDir, 'vitest')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'client.mjs')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'script-shell')).mode & 0o777).toBe(0o700);
    expect(statSync(join(shellDir, 'path-hook')).mode & 0o777).toBe(0o600);
    expect(statSync(join(shellDir, 'bash-env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(shellDir, 'posix-env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(shellDir, 'zsh', '.zprofile')).mode & 0o777).toBe(
      0o600,
    );
    expect(env).toMatchObject({
      PATH: `${binDir}${delimiter}/usr/bin`,
      DYNOBOX_CLI_MOCK_SOCKET: '/tmp/mock.sock',
      DYNOBOX_CLI_MOCK_TOKEN: 'token',
      DYNOBOX_CLI_MOCK_BIN: binDir,
      DYNOBOX_CLI_MOCK_TIMEOUT_MS: '1020',
      DYNOBOX_CLI_MOCK_SCRIPT_SHELL: '/bin/bash',
      DYNOBOX_CLI_MOCK_PATH_HOOK: join(shellDir, 'path-hook'),
      DYNOBOX_CLI_MOCK_BASE_BASH_ENV: '/home/test/bash-env',
      DYNOBOX_CLI_MOCK_BASE_POSIX_ENV: '/home/test/posix-env',
      DYNOBOX_CLI_MOCK_BASE_ZDOTDIR: '/home/test',
      BASH_ENV: join(shellDir, 'bash-env'),
      ENV: join(shellDir, 'posix-env'),
      ZDOTDIR: join(shellDir, 'zsh'),
      npm_config_script_shell: join(root, 'script-shell'),
      NPM_CONFIG_SCRIPT_SHELL: join(root, 'script-shell'),
    });
  });
});
