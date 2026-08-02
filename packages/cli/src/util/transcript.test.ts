import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {LocalRunnerResult} from '@dynobox/runner-local';
import {afterEach, describe, expect, it} from 'vitest';

import {writeDebugLogs} from './transcript.js';

const workDirs: string[] = [];

afterEach(() => {
  for (const workDir of workDirs.splice(0)) {
    rmSync(workDir, {force: true, recursive: true});
  }
});

describe('writeDebugLogs CLI mocks', () => {
  it('writes complete call records as pretty JSON without environment data', () => {
    const workDir = createWorkDir();
    const result = makeResult(workDir, [
      {
        executable: 'vitest',
        argv: ['run'],
        cwd: workDir,
        timestamp: 123,
        exitCode: 1,
        stdout: 'output',
        stderr: 'failure',
      },
    ]);

    const paths = writeDebugLogs(result);
    expect(paths.cliMocks).toBe(join(workDir, 'dynobox-cli-mocks.json'));
    const contents = readFileSync(paths.cliMocks!, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(contents).toContain('\n  {\n');
    expect(JSON.parse(contents)).toEqual(result.cliMockCalls);
    expect(contents).not.toContain('env');
  });

  it('omits the artifact when no CLI mocks were called', () => {
    const workDir = createWorkDir();

    const paths = writeDebugLogs(makeResult(workDir, []));

    expect(paths.cliMocks).toBeUndefined();
    expect(existsSync(join(workDir, 'dynobox-cli-mocks.json'))).toBe(false);
  });
});

function createWorkDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), 'dynobox-transcript-test-'));
  workDirs.push(workDir);
  return workDir;
}

function makeResult(
  workDir: string,
  cliMockCalls: LocalRunnerResult['cliMockCalls'],
): LocalRunnerResult {
  return {
    jobId: 'job.test',
    scenarioId: 'scenario.test',
    harness: 'claude-code',
    harnessVersion: null,
    iteration: 0,
    status: 'passed',
    passed: true,
    workDir,
    setupResult: {success: true, logs: []},
    httpEvents: [],
    cliMockCalls,
    artifacts: [],
    assertionResults: [],
    diagnostics: [],
    warnings: [],
    timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
  };
}
