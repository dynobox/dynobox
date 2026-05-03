import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  FakeHarness,
  type Harness,
  type HarnessInput,
  type HarnessResult,
  type HarnessRunOutput,
  type ShellToolEvent,
} from '@dynobox/runner-local';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  buildLocalRunnerJobs,
  configErrorExitCode,
  executeCli,
  placeholderExitCode,
  renderPlaceholderMessage,
  renderRunConfigErrorMessage,
  renderRunHeader,
  runCli,
  runFailureExitCode,
} from './index.js';

const ANSI_ESCAPE_PATTERN = /\x5B[0-9;]*m/g;
const EXPECTED_STDERR = `
  dynobox

  Cross-harness testing for multi-step agent flows.

  This package is a placeholder. Dynobox is under active development.

  Follow along:  https://dynobox.dev
  GitHub:        https://github.com/dynobox/dynobox
`;
const FIXTURE_DIR = join(process.cwd(), '.tmp-dynobox-cli-tests');
const VALID_CONFIG_PATH = join(FIXTURE_DIR, 'valid.config.ts');
const INVALID_CONFIG_PATH = join(FIXTURE_DIR, 'invalid.config.ts');
const SETUP_FAIL_CONFIG_PATH = join(FIXTURE_DIR, 'setup-fail.config.ts');
const MODALITIES_CONFIG_PATH = join(FIXTURE_DIR, 'modalities.config.ts');
const SEQUENCE_FAIL_CONFIG_PATH = join(FIXTURE_DIR, 'sequence-fail.config.ts');
const DYNO_MJS_CONFIG_PATH = join(FIXTURE_DIR, 'typed.dyno.mjs');
const VALID_CONFIG = `import {defineConfig, tool} from '@dynobox/sdk';

export default defineConfig({
  name: 'cli-local-runner',
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test and summarize the result.',
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'pnpm test'}),
      ],
    },
  ],
});
`;
const INVALID_CONFIG = `export default {
  scenarios: [{name: 'missing prompt'}],
};
`;
const SETUP_FAIL_CONFIG = `import {defineConfig, tool} from '@dynobox/sdk';

export default defineConfig({
  scenarios: [
    {
      name: 'setup breaks',
      prompt: 'Run pnpm test.',
      setup: ['echo setup failed >&2 && exit 7'],
      assertions: [tool.called('shell')],
    },
  ],
});
`;
const MODALITIES_CONFIG = `import {artifact, defineConfig, finalMessage, sequence, tool, transcript} from '@dynobox/sdk';

export default defineConfig({
  scenarios: [
    {
      name: 'modalities',
      prompt: 'Test assertion modalities.',
      setup: ['printf dynobox@0.0.5 > CHANGELOG.md'],
      assertions: [
        tool.notCalled('shell', {includes: 'npm publish'}),
        artifact.exists('CHANGELOG.md'),
        artifact.contains('CHANGELOG.md', 'dynobox@0.0.5'),
        transcript.contains('EOTP'),
        finalMessage.contains('working tree is dirty'),
        sequence.inOrder([
          tool.called('shell', {includes: 'git status'}),
          tool.called('shell', {includes: 'git commit'}),
        ]),
      ],
    },
  ],
});
`;
const SEQUENCE_FAIL_CONFIG = `import {defineConfig, sequence, tool} from '@dynobox/sdk';

export default defineConfig({
  scenarios: [
    {
      name: 'sequence fails',
      prompt: 'Commit safely.',
      assertions: [
        sequence.inOrder([
          tool.called('shell', {includes: 'git status'}),
          tool.called('shell', {includes: 'git commit'}),
        ]),
      ],
    },
  ],
});
`;
const DYNO_MJS_CONFIG = `import {defineConfig, dyno, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineConfig({
  scenarios: [
    {
      name: 'uses dyno mjs',
      prompt: 'Run pnpm test.',
      setup: [
        'cp ' + here.q('fixtures/repo/marker.txt') + ' marker.txt',
      ],
      assertions: [tool.called('shell')],
    },
  ],
});
`;
const SHELL_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'pnpm test'},
  command: 'pnpm test',
};
const MISMATCHED_SHELL_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'npm test'},
  command: 'npm test',
};
const GIT_STATUS_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'git status'},
  command: 'git status',
};
const GIT_COMMIT_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'git commit -m test'},
  command: 'git commit -m test',
};
const MULTILINE_GIT_COMMIT_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {
    command: `pnpm test && git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
  },
  command: `pnpm test && git commit -m "$(cat <<'EOF'\nmessage\nEOF\n)"`,
};

function createPassingHarness(): FakeHarness {
  return new FakeHarness(undefined, {toolEvents: [SHELL_EVENT]});
}

class StreamingHarness implements Harness {
  readonly id = 'claude-code' as const;

  constructor(private readonly toolEvent: ShellToolEvent = SHELL_EVENT) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    input.onToolEvent?.(this.toolEvent);
    return {
      exitCode: 0,
      stdout: 'fake output',
      stderr: '',
      durationMs: 100,
    };
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout,
      toolEvents: [this.toolEvent],
    };
  }
}

class PassingHarness implements Harness {
  constructor(readonly id: 'claude-code' | 'codex') {}

  async run(_input: HarnessInput): Promise<HarnessRunOutput> {
    return {
      exitCode: 0,
      stdout: 'fake output',
      stderr: '',
      durationMs: 100,
    };
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout,
      toolEvents: [SHELL_EVENT],
    };
  }
}

function expectedPassingRunOutput(configPath: string): string {
  return renderRunHeader(configPath, [
    {
      id: 'scenario.uses-shell.iteration.0',
      iteration: 0,
      harness: 'claude-code',
      scenario: {
        id: 'scenario.uses-shell',
        name: 'uses shell',
        prompt: 'Run pnpm test and summarize the result.',
        harnesses: ['claude-code'],
        setup: [],
        endpoints: [],
        assertions: [],
      },
    },
  ]);
}

/**
 * Removes ANSI escape sequences so test assertions can compare plain text.
 *
 * @param text The terminal output to normalize.
 * @returns The input string without ANSI escape codes.
 */
function stripAnsi(text: string): string {
  return text.replaceAll('\x1B', '').replace(ANSI_ESCAPE_PATTERN, '');
}

describe('packages/cli', () => {
  beforeAll(() => {
    rmSync(FIXTURE_DIR, {force: true, recursive: true});
    mkdirSync(FIXTURE_DIR, {recursive: true});
    writeFileSync(VALID_CONFIG_PATH, VALID_CONFIG);
    writeFileSync(INVALID_CONFIG_PATH, INVALID_CONFIG);
    writeFileSync(SETUP_FAIL_CONFIG_PATH, SETUP_FAIL_CONFIG);
    writeFileSync(MODALITIES_CONFIG_PATH, MODALITIES_CONFIG);
    writeFileSync(SEQUENCE_FAIL_CONFIG_PATH, SEQUENCE_FAIL_CONFIG);
    mkdirSync(join(FIXTURE_DIR, 'fixtures/repo'), {recursive: true});
    writeFileSync(join(FIXTURE_DIR, 'fixtures/repo/marker.txt'), 'ready');
    writeFileSync(DYNO_MJS_CONFIG_PATH, DYNO_MJS_CONFIG);
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, {force: true, recursive: true});
  });

  it('renders the placeholder message', () => {
    expect(stripAnsi(renderPlaceholderMessage())).toBe(EXPECTED_STDERR);
  });

  it('renders the run header', () => {
    expect(
      renderRunHeader('./config.ts', [
        {
          id: 'scenario.test.iteration.0',
          iteration: 0,
          harness: 'claude-code',
          scenario: {
            id: 'scenario.test',
            name: 'test',
            prompt: 'Run a test.',
            harnesses: ['claude-code'],
            setup: [],
            endpoints: [],
            assertions: [],
          },
        },
      ]),
    ).toContain('plan     1 scenario · 1 harness · 1 iteration');
  });

  it('expands jobs across scenario harnesses', () => {
    expect(
      buildLocalRunnerJobs({
        version: '0.1',
        scenarios: [
          {
            id: 'scenario.test',
            name: 'test',
            prompt: 'Run a test.',
            harnesses: ['claude-code', 'codex'],
            setup: [],
            endpoints: [],
            assertions: [],
          },
        ],
      }).map((job) => ({id: job.id, harness: job.harness})),
    ).toEqual([
      {id: 'scenario.test.claude-code.iteration.0', harness: 'claude-code'},
      {id: 'scenario.test.codex.iteration.0', harness: 'codex'},
    ]);
  });

  it('renders the run config error message', () => {
    expect(renderRunConfigErrorMessage('./config.ts', 'bad config')).toBe(
      `dynobox run

config: ./config.ts
error: bad config
`,
    );
  });

  it('routes no args to the placeholder message', async () => {
    await expect(executeCli([])).resolves.toEqual({
      exitCode: placeholderExitCode,
      stdout: '',
      stderr: renderPlaceholderMessage(),
    });
  });

  it('requires an explicit config path for run', async () => {
    const result = await executeCli(['run']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      "error: missing required argument 'config'",
    );
  });

  it('runs an explicit config path', async () => {
    await expect(
      executeCli(['run', VALID_CONFIG_PATH], {
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
      executeCli(['run', DYNO_MJS_CONFIG_PATH], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('✓  uses dyno mjs'),
      stderr: '',
    });
  });

  it('prints quiet output for CI-style runs', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--quiet'], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'dynobox  1 scenario · 1 harness · 1 iteration',
    );
    expect(result.stdout).toContain('\n  .\n');
    expect(result.stdout).toContain('1 passed, 0 failed in 0.1s');
  });

  it('can override config harnesses from the CLI', async () => {
    const result = await executeCli(
      ['run', VALID_CONFIG_PATH, '--harness', 'codex', '--quiet'],
      {
        harnesses: [new PassingHarness('codex')],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'dynobox  1 scenario · 1 harness · 1 iteration',
    );
  });

  it('rejects invalid CLI harness overrides', async () => {
    const result = await executeCli([
      'run',
      VALID_CONFIG_PATH,
      '--harness',
      'nope',
    ]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('Invalid harness "nope"');
  });

  it('prints live tool progress when live output is enabled', async () => {
    const writes: string[] = [];
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--verbose'], {
      harnesses: [new StreamingHarness()],
      live: true,
      writeStdout: (value) => writes.push(value),
    });

    expect(result.exitCode).toBe(0);
    expect(writes.join('')).toContain('Bash: pnpm test 1 tool');
    expect(writes.join('')).toContain('✓ tool.called(shell)');
    expect(writes.join('')).toContain('1 passed');
  });

  it('keeps multiline live shell progress on one rendered row', async () => {
    const writes: string[] = [];
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--verbose'], {
      harnesses: [new StreamingHarness(MULTILINE_GIT_COMMIT_EVENT)],
      live: true,
      color: true,
      writeStdout: (value) => writes.push(value),
    });

    const toolWrites = writes.filter((value) => value.includes('Bash:'));
    expect(result.exitCode).toBe(0);
    expect(toolWrites).toHaveLength(1);
    expect(toolWrites[0]).toContain(`Bash: pnpm test && git commit -m`);
    expect(toolWrites[0]).not.toContain('\n');
  });

  it('collapses passing scenarios to a one-liner in default mode', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓  uses shell');
    expect(result.stdout).not.toContain('✓ setup');
    expect(result.stdout).not.toContain('✓ harness');
    expect(result.stdout).not.toContain('tool.called(shell)');
  });

  it('expands all phase rows in verbose mode', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--verbose'], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓  uses shell');
    expect(result.stdout).toContain('setup      0 commands');
    expect(result.stdout).toContain('harness    ran prompt');
    expect(result.stdout).toContain('assertions 2 of 2 passed');
    expect(result.stdout).toContain('✓ tool.called(shell)');
  });

  it('can render plain fallback symbols', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--verbose'], {
      harnesses: [createPassingHarness()],
      usePlainSymbols: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[ ok ]  uses shell');
    expect(result.stdout).toContain('[ ok ] tool.called(shell)');
    expect(result.stdout).not.toContain('✓');
  });

  it('includes work directory details in debug mode', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH, '--debug'], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('work dir');
    expect(result.stdout).toContain('artifact  work_dir');
  });

  it('exits nonzero when assertions fail', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH], {
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
      ['run', MODALITIES_CONFIG_PATH, '--verbose'],
      {
        harnesses: [
          new FakeHarness(
            {stdout: 'transcript EOTP\nworking tree is dirty'},
            {toolEvents: [GIT_STATUS_EVENT, GIT_COMMIT_EVENT]},
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
  });

  it('renders failed sequence expectations and observed shell commands', async () => {
    const result = await executeCli(['run', SEQUENCE_FAIL_CONFIG_PATH], {
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
    const result = await executeCli(['run', SETUP_FAIL_CONFIG_PATH], {
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

  it('exits nonzero with diagnostics when local execution fails', async () => {
    const result = await executeCli(['run', VALID_CONFIG_PATH], {
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

  it('exits nonzero when config validation fails', async () => {
    const result = await executeCli(['run', INVALID_CONFIG_PATH]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${INVALID_CONFIG_PATH}`);
    expect(result.stderr).toContain('error:');
    expect(result.stderr).toContain('prompt');
  });

  it('exits nonzero when config loading fails', async () => {
    const missingPath = join(FIXTURE_DIR, 'missing.config.ts');

    const result = await executeCli(['run', missingPath]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`config: ${missingPath}`);
    expect(result.stderr).toContain('error:');
  });

  it('rejects unknown commands', async () => {
    const result = await executeCli(['nope']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'nope'");
  });

  it('writes the placeholder message to stderr and returns the exit code', async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(runCli([])).resolves.toBe(placeholderExitCode);
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stripAnsi(stderrWrite.mock.calls[0]?.[0] as string)).toBe(
      EXPECTED_STDERR,
    );

    stderrWrite.mockRestore();
  });

  it('writes run output to stdout and returns the exit code', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await expect(
      runCli(['run', VALID_CONFIG_PATH], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toBe(0);
    expect(stdoutWrite.mock.calls.map((call) => call[0]).join('')).toContain(
      expectedPassingRunOutput(VALID_CONFIG_PATH),
    );

    stdoutWrite.mockRestore();
  });
});
