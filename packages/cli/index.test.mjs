import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

const ANSI_ESCAPE_PATTERN = /\x5B[0-9;]*m/g;
const TEST_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

function stripAnsi(text) {
  return text.replaceAll('\x1B', '').replace(ANSI_ESCAPE_PATTERN, '');
}

describe('packages/cli placeholder', () => {
  it('matches the placeholder output snapshot', () => {
    const result = spawnSync(process.execPath, ['index.js'], {
      cwd: TEST_DIRECTORY,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(stripAnsi(result.stderr)).toMatchSnapshot();
    expect(result.stdout).toBe('');
  });
});
