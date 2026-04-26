import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {runScenarioSetup, runSetup} from './setup.js';

const tempDirs: string[] = [];

function createWorkDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), 'dynobox-setup-'));
  tempDirs.push(workDir);
  return workDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {force: true, recursive: true});
  }
});

describe('runSetup', () => {
  it('returns success with empty commands array', async () => {
    const result = await runSetup({
      commands: [],
      workDir: createWorkDir(),
    });

    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(0);
  });

  it('runs a single successful command', async () => {
    const result = await runSetup({
      commands: ['echo hello'],
      workDir: createWorkDir(),
    });

    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.exitCode).toBe(0);
    expect(result.logs[0]!.stdout.trim()).toBe('hello');
  });

  it('runs multiple commands sequentially', async () => {
    const result = await runSetup({
      commands: ['echo first', 'echo second'],
      workDir: createWorkDir(),
    });

    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]!.stdout.trim()).toBe('first');
    expect(result.logs[1]!.stdout.trim()).toBe('second');
  });

  it('stops at the first non-zero exit', async () => {
    const workDir = createWorkDir();
    const markerPath = join(workDir, 'after-failure.txt');
    const result = await runSetup({
      commands: [
        'echo before',
        'false',
        `node -e "require('node:fs').writeFileSync(process.argv[1], 'after')" ${JSON.stringify(markerPath)}`,
      ],
      workDir,
    });

    expect(result.success).toBe(false);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]!.stdout.trim()).toBe('before');
    expect(result.logs[1]!.exitCode).not.toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('captures stderr on failure', async () => {
    const result = await runSetup({
      commands: ['echo oops >&2 && exit 1'],
      workDir: createWorkDir(),
    });

    expect(result.success).toBe(false);
    expect(result.logs[0]!.stderr.trim()).toBe('oops');
    expect(result.logs[0]!.exitCode).toBe(1);
  });

  it('records durationMs for each command', async () => {
    const result = await runSetup({
      commands: ['echo fast'],
      workDir: createWorkDir(),
    });

    expect(result.logs[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs commands in the supplied workDir', async () => {
    const workDir = createWorkDir();
    const markerPath = join(workDir, 'cwd.txt');
    const result = await runSetup({
      commands: [
        "node -e \"require('node:fs').writeFileSync('cwd.txt', process.cwd())\"",
      ],
      workDir,
    });

    expect(result.success).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe(realpathSync(workDir));
  });

  it('makes env overrides available to setup commands', async () => {
    const result = await runSetup({
      commands: ['node -e "console.log(process.env.DYNOBOX_SETUP_TEST)"'],
      workDir: createWorkDir(),
      env: {DYNOBOX_SETUP_TEST: 'available'},
    });

    expect(result.success).toBe(true);
    expect(result.logs[0]!.stdout.trim()).toBe('available');
  });
});

describe('runScenarioSetup', () => {
  it('runs setup commands from the compiled scenario', async () => {
    const result = await runScenarioSetup({
      scenario: {setup: ['echo scenario setup']},
      workDir: createWorkDir(),
    });

    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.stdout.trim()).toBe('scenario setup');
  });
});
