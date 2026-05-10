import {join} from 'node:path';

import {FakeHarness, type ToolEvent} from '@dynobox/runner-local';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {
  createFixtureSet,
  createPassingHarness,
  GIT_COMMIT_EVENT,
  GIT_STATUS_EVENT,
  MISMATCHED_SHELL_EVENT,
  MULTILINE_GIT_COMMIT_EVENT,
  SKILL_READ_EVENT,
  StreamingHarness,
} from '../testUtils.js';
import {executeCli} from './execute.js';
import {configErrorExitCode, runFailureExitCode} from './exitCodes.js';

const fixtures = createFixtureSet('runCommand');
const COMMIT_SKILL_PATH = '/tmp/work/.agents/skills/commit/SKILL.md';
const RELEASE_SKILL_PATH = '/tmp/work/.agents/skills/release/SKILL.md';

const NESTED_COMMIT_SKILL_READ_EVENT: ToolEvent = {
  kind: 'read_file',
  rawName: 'Read',
  input: {request: {file_path: COMMIT_SKILL_PATH}},
};

const RELEASE_SKILL_READ_EVENT: ToolEvent = {
  kind: 'read_file',
  rawName: 'Read',
  input: {file_path: RELEASE_SKILL_PATH},
};

describe('dynobox run — config loading', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('runs an explicit config path', async () => {
    await expect(
      executeCli(['run', fixtures.validConfigPath], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('✓  uses shell'),
      stderr: '',
    });
  });

  it('runs a dyno mjs config with SDK helpers', async () => {
    await expect(
      executeCli(['run', fixtures.dynoMjsConfigPath], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('✓  uses dyno mjs'),
      stderr: '',
    });
  });

  it('exits nonzero when config validation fails', async () => {
    const result = await executeCli(['run', fixtures.invalidConfigPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${fixtures.invalidConfigPath}`);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).toContain('prompt');
  });

  it('exits nonzero when config loading fails', async () => {
    const missingPath = join(fixtures.dir, 'missing.config.ts');

    const result = await executeCli(['run', missingPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${missingPath}`);
    expect(result.stderr).toContain('error:');
  });
});

describe('dynobox run — output modes', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('prints quiet output for CI-style runs', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--quiet'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'dynobox  1 scenario · 1 harness · 1 iteration',
    );
    expect(result.stdout).toContain('\n  .\n');
    expect(result.stdout).toContain('1 passed, 0 failed in 0.1s');
  });

  it('collapses passing scenarios to a one-liner in default mode', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓  uses shell');
    expect(result.stdout).not.toContain('✓ setup');
    expect(result.stdout).not.toContain('✓ harness');
    expect(result.stdout).not.toContain('tool.called(shell)');
  });

  it('expands all phase rows in verbose mode', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--verbose'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓  uses shell');
    expect(result.stdout).toContain('setup      0 commands');
    expect(result.stdout).toContain('harness    ran prompt');
    expect(result.stdout).toContain('assertions 2 of 2 passed');
    expect(result.stdout).toContain('✓ tool.called(shell)');
  });

  it('renders plain fallback symbols when ANSI is disabled', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--verbose'],
      {
        harnesses: [createPassingHarness()],
        usePlainSymbols: true,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[ ok ]  uses shell');
    expect(result.stdout).toContain('[ ok ] tool.called(shell)');
    expect(result.stdout).not.toContain('✓');
  });

  it('includes work directory details in debug mode', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--debug'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('work dir');
    expect(result.stdout).toContain('artifact  work_dir');
  });
});

describe('dynobox run — live output', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('prints live tool progress when live output is enabled', async () => {
    const writes: string[] = [];
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--verbose'],
      {
        harnesses: [new StreamingHarness()],
        live: true,
        writeStdout: (value) => writes.push(value),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(writes.join('')).toContain('Bash: pnpm test 1 tool');
    expect(writes.join('')).toContain('✓ tool.called(shell)');
    expect(writes.join('')).toContain('1 passed');
  });

  it('keeps multiline live shell progress on one rendered row', async () => {
    const writes: string[] = [];
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--verbose'],
      {
        harnesses: [new StreamingHarness(MULTILINE_GIT_COMMIT_EVENT)],
        live: true,
        color: true,
        writeStdout: (value) => writes.push(value),
      },
    );

    const toolWrites = writes.filter((value) => value.includes('Bash:'));
    expect(result.exitCode).toBe(0);
    expect(toolWrites).toHaveLength(1);
    expect(toolWrites[0]).toContain(`Bash: pnpm test && git commit -m`);
    expect(toolWrites[0]).not.toContain('\n');
  });
});

describe('dynobox run — failures and diagnostics', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);

  it('exits nonzero when assertions fail', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [
        new FakeHarness(undefined, {toolEvents: [MISMATCHED_SHELL_EVENT]}),
      ],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗  uses shell');
    expect(result.stdout).toContain('✗ assertions 1 of 2 passed');
    expect(result.stdout).toContain(
      '✗ tool.called(shell, includes: pnpm test)',
    );
    expect(result.stdout).toContain(
      'expected  shell command including "pnpm test"',
    );
    expect(result.stdout).toContain('observed shell commands during this run:');
    expect(result.stdout).toContain('1. npm test');
    expect(result.stdout).toContain('0 passed   1 failed');
    expect(result.stderr).toBe('');
  });

  it('describes new assertion kinds in verbose output', async () => {
    const result = await executeCli(
      ['run', fixtures.modalitiesConfigPath, '--verbose'],
      {
        harnesses: [
          new FakeHarness(
            {stdout: 'transcript EOTP\nworking tree is dirty'},
            {
              toolEvents: [
                GIT_STATUS_EVENT,
                GIT_COMMIT_EVENT,
                SKILL_READ_EVENT,
              ],
            },
          ),
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      '✓ tool.notCalled(shell, includes: npm publish)',
    );
    expect(result.stdout).toContain('✓ artifact.exists(CHANGELOG.md)');
    expect(result.stdout).toContain('✓ artifact.contains(CHANGELOG.md)');
    expect(result.stdout).toContain('✓ transcript.contains');
    expect(result.stdout).toContain('✓ finalMessage.contains');
    expect(result.stdout).toContain('✓ sequence.inOrder(2 steps)');
    expect(result.stdout).toContain('✓ skill.invoked(commit)');
  });

  it('shows observed skill files in verbose output without duplicates', async () => {
    const result = await executeCli(
      ['run', fixtures.modalitiesConfigPath, '--verbose'],
      {
        harnesses: [
          new FakeHarness(
            {stdout: 'transcript EOTP\nworking tree is dirty'},
            {
              toolEvents: [
                GIT_STATUS_EVENT,
                GIT_COMMIT_EVENT,
                NESTED_COMMIT_SKILL_READ_EVENT,
                NESTED_COMMIT_SKILL_READ_EVENT,
              ],
            },
          ),
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('observed skill files during this run:');
    expect(result.stdout).toContain(`1. ${COMMIT_SKILL_PATH}`);
    expect(result.stdout).not.toContain(`2. ${COMMIT_SKILL_PATH}`);
  });

  it('shows observed skill files when skill invocation assertions fail', async () => {
    const result = await executeCli(['run', fixtures.modalitiesConfigPath], {
      harnesses: [
        new FakeHarness(
          {stdout: 'transcript EOTP\nworking tree is dirty'},
          {
            toolEvents: [
              GIT_STATUS_EVENT,
              GIT_COMMIT_EVENT,
              RELEASE_SKILL_READ_EVENT,
            ],
          },
        ),
      ],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗ skill.invoked(commit)');
    expect(result.stdout).toContain(
      'expected  skill "commit" instruction file access',
    );
    expect(result.stdout).toContain(
      'observed  Expected skill "commit" to be invoked, but no access to its SKILL.md was observed.',
    );
    expect(result.stdout).toContain('observed skill files during this run:');
    expect(result.stdout).toContain(`1. ${RELEASE_SKILL_PATH}`);
  });

  it('shows no observed skill files when skill invocation evidence is absent', async () => {
    const result = await executeCli(['run', fixtures.modalitiesConfigPath], {
      harnesses: [
        new FakeHarness(
          {stdout: 'transcript EOTP\nworking tree is dirty'},
          {toolEvents: [GIT_STATUS_EVENT, GIT_COMMIT_EVENT]},
        ),
      ],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('observed skill files during this run:');
    expect(result.stdout).toContain('(none)');
    expect(result.stdout).not.toContain(
      'observed shell commands during this run:',
    );
  });

  it('renders failed sequence expectations and observed shell commands', async () => {
    const result = await executeCli(['run', fixtures.sequenceFailConfigPath], {
      harnesses: [
        new FakeHarness(undefined, {
          toolEvents: [GIT_COMMIT_EVENT, GIT_STATUS_EVENT],
        }),
      ],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗ sequence.inOrder(2 steps)');
    expect(result.stdout).toContain(
      'expected  shell command including "git status" before shell command including "git commit"',
    );
    expect(result.stdout).toContain('observed shell commands during this run:');
    expect(result.stdout).toContain('1. git commit -m test');
    expect(result.stdout).toContain('2. git status');
  });

  it('shows skipped phases when setup fails', async () => {
    const result = await executeCli(['run', fixtures.setupFailConfigPath], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗  setup breaks');
    expect(result.stdout).toContain('✗ setup      1 command');
    expect(result.stdout).toContain('$ echo setup failed >&2 && exit 7');
    expect(result.stdout).toContain('exit code 7');
    expect(result.stdout).toContain('setup failed');
    expect(result.stdout).toContain('– harness    skipped');
    expect(result.stdout).toContain('– assertions skipped');
  });

  it('exits nonzero with diagnostics when no harness is registered', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗  uses shell');
    expect(result.stdout).toContain('✗ harness    failed');
    expect(result.stdout).toContain(
      'No harness registered for scenario harness "claude-code".',
    );
    expect(result.stdout).toContain('– assertions skipped');
    expect(result.stderr).toBe('');
  });
});
