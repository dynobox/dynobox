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
    });
    const binDir = join(root, 'bin');

    expect(statSync(join(binDir, 'vitest')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'client.mjs')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'script-shell')).mode & 0o777).toBe(0o700);
    expect(env).toMatchObject({
      PATH: `${binDir}${delimiter}/usr/bin`,
      DYNOBOX_CLI_MOCK_SOCKET: '/tmp/mock.sock',
      DYNOBOX_CLI_MOCK_TOKEN: 'token',
      DYNOBOX_CLI_MOCK_BIN: binDir,
      DYNOBOX_CLI_MOCK_TIMEOUT_MS: '1020',
      DYNOBOX_CLI_MOCK_SCRIPT_SHELL: '/bin/bash',
      npm_config_script_shell: join(root, 'script-shell'),
      NPM_CONFIG_SCRIPT_SHELL: join(root, 'script-shell'),
    });
  });
});
