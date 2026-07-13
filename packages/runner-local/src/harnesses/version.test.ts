import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {createVersionProbe, parseVersion} from './version.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-version-test-'));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

afterEach(() => {
  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, {force: true, recursive: true});
  }
});

function createFakeExecutable(script: string): string {
  const executable = join(createScratchRoot(), 'fake-cli');
  writeFileSync(executable, `#!/bin/sh\n${script}\n`, {mode: 0o755});
  return executable;
}

describe('createVersionProbe', () => {
  it('resolves the parsed version from --version output', async () => {
    const executable = createFakeExecutable(
      `printf '%s\\n' '1.2.3 (Fake CLI)'`,
    );

    await expect(createVersionProbe(executable)()).resolves.toBe('1.2.3');
  });

  it('resolves null when the executable exits non-zero', async () => {
    const executable = createFakeExecutable(`printf '%s\\n' '1.2.3'\nexit 1`);

    await expect(createVersionProbe(executable)()).resolves.toBe(null);
  });

  it('resolves null when the executable is missing', async () => {
    const executable = join(createScratchRoot(), 'missing-cli');

    await expect(createVersionProbe(executable)()).resolves.toBe(null);
  });

  it('caches the probe result per executable', async () => {
    const countFile = join(createScratchRoot(), 'count');
    const executable = createFakeExecutable(
      `printf 'probe\\n' >> '${countFile}'\nprintf '%s\\n' "1.2.$(wc -l < '${countFile}' | tr -d ' ')"`,
    );
    const probe = createVersionProbe(executable);

    await expect(Promise.all([probe(), probe(), probe()])).resolves.toEqual([
      '1.2.1',
      '1.2.1',
      '1.2.1',
    ]);
  });
});

describe('parseVersion', () => {
  it('extracts semantic versions from surrounding text', () => {
    expect(parseVersion('2.1.4 (Claude Code)')).toBe('2.1.4');
    expect(parseVersion('codex-cli 0.87.0')).toBe('0.87.0');
  });

  it('strips a leading v prefix', () => {
    expect(parseVersion('fake-cli v3.0.1')).toBe('3.0.1');
  });

  it('keeps pre-release and build suffixes', () => {
    expect(parseVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(parseVersion('1.2.3+build.7')).toBe('1.2.3+build.7');
  });

  it('accepts major.minor versions', () => {
    expect(parseVersion('release 4.2')).toBe('4.2');
  });

  it('returns null when no version is present', () => {
    expect(parseVersion('version unknown')).toBe(null);
    expect(parseVersion('')).toBe(null);
  });
});
