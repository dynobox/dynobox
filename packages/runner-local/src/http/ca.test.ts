import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {ensureDynoboxCA} from './ca.js';

const tempDirs: string[] = [];

function createHomeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dynobox-ca-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {force: true, recursive: true});
  }
});

describe('ensureDynoboxCA', () => {
  it('generates and reuses a local CA', async () => {
    const homeDir = createHomeDir();

    const first = await ensureDynoboxCA({homeDir});
    const firstCert = readFileSync(first.certPath, 'utf8');
    const firstKey = readFileSync(first.keyPath, 'utf8');
    const second = await ensureDynoboxCA({homeDir});

    expect(first.generated).toBe(true);
    expect(second.generated).toBe(false);
    expect(first.certPath).toBe(join(homeDir, '.dynobox', 'ca.pem'));
    expect(first.keyPath).toBe(join(homeDir, '.dynobox', 'ca-key.pem'));
    expect(existsSync(first.certPath)).toBe(true);
    expect(existsSync(first.keyPath)).toBe(true);
    expect(readFileSync(second.certPath, 'utf8')).toBe(firstCert);
    expect(readFileSync(second.keyPath, 'utf8')).toBe(firstKey);
  });
});
