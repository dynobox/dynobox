import {mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative} from 'node:path';

import {
  FakeHarness,
  type Harness,
  type HarnessInput,
  type HarnessResult,
  type HarnessRunOutput,
  type ShellToolEvent,
  type ToolEvent,
} from '@dynobox/runner-local';
import type {HarnessId} from '@dynobox/sdk';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  createFixtureSet,
  createPassingHarness,
  GIT_COMMIT_EVENT,
  GIT_STATUS_EVENT,
  MISMATCHED_SHELL_EVENT,
  MULTILINE_GIT_COMMIT_EVENT,
  SHELL_EVENT,
  SKILL_READ_EVENT,
  StreamingHarness,
} from '../testUtils.js';
import {executeCli} from './execute.js';
import {configErrorExitCode, runFailureExitCode} from './exitCodes.js';

const fixtures = createFixtureSet('runCommand');
const COMMIT_SKILL_PATH = '/tmp/work/.agents/skills/commit/SKILL.md';
const RELEASE_SKILL_PATH = '/tmp/work/.agents/skills/release/SKILL.md';

function stubFetch(response: typeof fetch) {
  const fetchMock = vi.fn(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

const PERMISSION_DENIED_GIT_EVENT: ShellToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'git commit -m test'},
  command: 'git commit -m test',
  status: 'failure',
  message: 'Permission denied',
};

function expectStringArray(value: unknown): string[] {
  expect(Array.isArray(value)).toBe(true);
  return value as string[];
}

class CapturingHarness implements Harness {
  readonly inputs: HarnessInput[] = [];

  constructor(readonly id: HarnessId) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    this.inputs.push(input);
    return {exitCode: 0, stdout: 'fake output', stderr: '', durationMs: 100};
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

type ConcurrencyTracker = {
  active: number;
  maxActive: number;
  activeByHarness: Map<HarnessId, number>;
  maxActiveByHarness: Map<HarnessId, number>;
};

class DelayedHarness implements Harness {
  constructor(
    readonly id: HarnessId,
    private readonly delayMs: number,
    private readonly tracker: ConcurrencyTracker,
  ) {}

  async run(_input: HarnessInput): Promise<HarnessRunOutput> {
    this.tracker.active += 1;
    this.tracker.maxActive = Math.max(
      this.tracker.maxActive,
      this.tracker.active,
    );
    const activeForHarness =
      (this.tracker.activeByHarness.get(this.id) ?? 0) + 1;
    this.tracker.activeByHarness.set(this.id, activeForHarness);
    this.tracker.maxActiveByHarness.set(
      this.id,
      Math.max(
        this.tracker.maxActiveByHarness.get(this.id) ?? 0,
        activeForHarness,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.tracker.active -= 1;
    this.tracker.activeByHarness.set(
      this.id,
      (this.tracker.activeByHarness.get(this.id) ?? 1) - 1,
    );
    return {exitCode: 0, stdout: 'fake output', stderr: '', durationMs: 100};
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

function createConcurrencyTracker(): ConcurrencyTracker {
  return {
    active: 0,
    maxActive: 0,
    activeByHarness: new Map(),
    maxActiveByHarness: new Map(),
  };
}

describe('dynobox run — config loading', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs an explicit config path', async () => {
    await expect(
      executeCli(['run', fixtures.validConfigPath], {
        harnesses: [createPassingHarness()],
      }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: expect.stringContaining('✓ 2 assertions'),
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
      stdout: expect.stringContaining('uses dyno mjs'),
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

  it('prints the resolved dyno.config.json under --verbose', async () => {
    const configFile = join(fixtures.dir, 'verbose-config', 'dyno.config.json');
    mkdirSync(dirname(configFile), {recursive: true});
    writeFileSync(configFile, JSON.stringify({ignoredDirectories: []}));

    const result = await executeCli(
      ['run', fixtures.dir, '--config', configFile, '--verbose'],
      {harnesses: [createPassingHarness()], mode: 'verbose'},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `config: ${relative(process.cwd(), configFile)}`,
    );
  });

  it('omits the config line without --verbose', async () => {
    const configFile = join(fixtures.dir, 'quiet-config', 'dyno.config.json');
    mkdirSync(dirname(configFile), {recursive: true});
    writeFileSync(configFile, JSON.stringify({ignoredDirectories: []}));

    const result = await executeCli(
      ['run', fixtures.dir, '--config', configFile],
      {harnesses: [createPassingHarness()]},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(
      `config: ${relative(process.cwd(), configFile)}`,
    );
  });
});

describe('dynobox run — upload', () => {
  beforeAll(fixtures.setup);
  afterAll(fixtures.teardown);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not upload without --save-run even when a token exists', async () => {
    const fetchMock = stubFetch(async () => Response.json({id: 'run-1'}));

    const result = await executeCli(['run', fixtures.validConfigPath], {
      env: {DYNOBOX_TOKEN: 'token'},
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stderr).toBe('');
  });

  it('uploads compact JSON-reporter runs to stderr without changing stdout', async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url).endsWith('/auth/identity')) {
        return Response.json({identity: {email: 'user@example.com'}});
      }

      return Response.json({
        id: 'run-1',
        url: 'https://dash.dynobox.xyz/runs/run-1',
      });
    });

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--reporter', 'json', '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'token',
        },
        harnesses: [createPassingHarness()],
      },
    );
    const stdoutRecords = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(stdoutRecords).toHaveLength(2);
    expect(result.stderr).toBe(
      'Saved run: https://dash.dynobox.xyz/runs/run-1\n',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8787/auth/identity',
      expect.objectContaining({
        headers: {authorization: 'Bearer token'},
        method: 'GET',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8787/runs',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
    );
    expect(payload).toMatchObject({
      schemaVersion: 4,
      git: expect.objectContaining({
        commit: expect.any(String),
        dirty: expect.any(Boolean),
      }),
      inputPath: fixtures.validConfigPath,
      status: 'passed',
      totals: {jobs: 1, passed: 1, failed: 0, warnings: 0},
      dynos: [
        {
          dynoPath: expect.stringContaining(basename(fixtures.validConfigPath)),
          target: basename(dirname(fixtures.validConfigPath)),
          status: 'passed',
          totals: {jobs: 1, passed: 1, failed: 0, warnings: 0},
          jobs: [
            {
              scenario: {name: 'uses shell'},
              harness: {id: 'claude-code', model: null, version: null},
              iteration: 1,
              status: 'passed',
              passed: true,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('workDir');
    expect(JSON.stringify(payload)).not.toContain('artifacts');
    expect(JSON.stringify(payload)).not.toContain('harnessOutput');
  });

  it('posts to a custom upload URL without Dynobox authentication', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({url: 'https://uploads.example/runs/123'}),
    );

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {
          DYNOBOX_TOKEN: 'must-not-leak',
          DYNOBOX_UPLOAD_URL: 'https://uploads.example/run-hook',
        },
        harnesses: [createPassingHarness()],
      },
    );
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('Saved run: https://uploads.example/runs/123\n');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://uploads.example/run-hook',
      expect.objectContaining({
        headers: {'content-type': 'application/json'},
        method: 'POST',
      }),
    );
    expect(payload).toMatchObject({schemaVersion: 4});
  });

  it('only uploads dynos with jobs after scenario filtering', async () => {
    const dir = join(fixtures.dir, 'filtered-upload');
    mkdirSync(dir, {recursive: true});
    writeFileSync(
      join(dir, 'alpha.dyno.ts'),
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'alpha scenario',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    writeFileSync(
      join(dir, 'beta.dyno.ts'),
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'beta scenario',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    const fetchMock = stubFetch(async (url) => {
      if (String(url).endsWith('/auth/identity')) {
        return Response.json({identity: {email: 'user@example.com'}});
      }

      return Response.json({id: 'run-1'});
    });

    const result = await executeCli(
      ['run', dir, '--scenario', 'alpha*', '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'token',
        },
        harnesses: [createPassingHarness()],
      },
    );
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({
      totals: {jobs: 1},
      dynos: [
        {
          dynoPath: expect.stringContaining('alpha.dyno.ts'),
          totals: {jobs: 1},
          jobs: [{scenario: {name: 'alpha scenario'}}],
        },
      ],
    });
  });

  it('errors before running when --save-run has no token', async () => {
    const fetchMock = stubFetch(async () => Response.json({id: 'run-1'}));
    const harness = createPassingHarness();
    const runSpy = vi.spyOn(harness, 'run');

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {HOME: join(fixtures.dir, 'missing-home')},
        harnesses: [harness],
      },
    );

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('--save-run requires a Dynobox token');
    // Fail fast: neither the harness nor the upload should have run.
    expect(runSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stdout).toBe('');
  });

  it('errors before running when --save-run auth is invalid', async () => {
    const fetchMock = stubFetch(async () => Response.json({}, {status: 401}));
    const harness = createPassingHarness();
    const runSpy = vi.spyOn(harness, 'run');

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'invalid-token',
        },
        harnesses: [harness],
      },
    );

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      '--save-run requires a valid Dynobox token',
    );
    expect(result.stderr).toContain('dynobox login');
    expect(result.stderr).toContain('DYNOBOX_TOKEN');
    expect(runSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/auth/identity',
      expect.objectContaining({method: 'GET'}),
    );
    expect(result.stdout).toBe('');
  });

  it('errors before running when --save-run token is expired', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json(
        {error: {code: 'token_expired', message: 'Token expired.'}},
        {status: 401},
      ),
    );
    const harness = createPassingHarness();
    const runSpy = vi.spyOn(harness, 'run');

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'expired-token',
        },
        harnesses: [harness],
      },
    );

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain('token expired');
    expect(result.stderr).toContain('dynobox login');
    expect(runSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/auth/identity',
      expect.objectContaining({method: 'GET'}),
    );
    expect(result.stdout).toBe('');
  });

  it('retries transient --save-run auth failures before running', async () => {
    let authAttempts = 0;
    const fetchMock = stubFetch(async (url) => {
      if (String(url).endsWith('/auth/identity')) {
        authAttempts += 1;
        return authAttempts < 3
          ? Response.json({}, {status: 503})
          : Response.json({identity: {email: 'user@example.com'}});
      }

      return Response.json({id: 'run-1'});
    });
    const harness = createPassingHarness();
    const runSpy = vi.spyOn(harness, 'run');

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'token',
        },
        harnesses: [harness],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/auth/identity',
      'http://localhost:8787/auth/identity',
      'http://localhost:8787/auth/identity',
      'http://localhost:8787/runs',
    ]);
  });

  it('errors before running when transient --save-run auth failures persist', async () => {
    const fetchMock = stubFetch(async () => Response.json({}, {status: 503}));
    const harness = createPassingHarness();
    const runSpy = vi.spyOn(harness, 'run');

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {
          DYNOBOX_API_URL: 'http://localhost:8787',
          DYNOBOX_TOKEN: 'token',
        },
        harnesses: [harness],
      },
    );

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      'Could not verify Dynobox authentication after 3 attempts',
    );
    expect(result.stderr).toContain('Try --save-run again later');
    expect(runSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/auth/identity',
      'http://localhost:8787/auth/identity',
      'http://localhost:8787/auth/identity',
    ]);
    expect(result.stdout).toBe('');
  });

  it('keeps run failure exit code when upload fails', async () => {
    stubFetch(async (url) => {
      if (String(url).endsWith('/auth/identity')) {
        return Response.json({identity: {email: 'user@example.com'}});
      }

      throw new Error('network down');
    });

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {DYNOBOX_TOKEN: 'token'},
        harnesses: [
          new FakeHarness(undefined, {toolEvents: [MISMATCHED_SHELL_EVENT]}),
        ],
      },
    );

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stderr).toContain(
      'warning: could not save run; upload request failed.',
    );
  });

  it('reports API upload errors without changing a passing run result', async () => {
    stubFetch(async (url) => {
      if (String(url).endsWith('/auth/identity')) {
        return Response.json({identity: {email: 'user@example.com'}});
      }

      return Response.json(
        {
          error: {
            code: 'unsupported_schema_version',
            message: 'Unsupported run payload schema version.',
          },
        },
        {status: 400},
      );
    });

    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--save-run'],
      {
        env: {DYNOBOX_TOKEN: 'token'},
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      'warning: could not save run; API returned HTTP 400 (unsupported_schema_version: Unsupported run payload schema version.).',
    );
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
      'dynobox  1 dyno · 1 scenario · harness: claude-code',
    );
    expect(result.stdout).toContain('\n  .\n');
    expect(result.stdout).toMatch(/1 job passed, 2 assertions in 0\.\ds/);
  });

  it('prints permission warnings for passing jobs', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [
        new FakeHarness(undefined, {
          toolEvents: [SHELL_EVENT, PERMISSION_DENIED_GIT_EVENT],
        }),
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ 2 assertions');
    expect(result.stdout).toContain(
      'permission denied for shell command: git commit -m test',
    );
    expect(result.stdout).toContain('· 1 warning ·');
  });

  it('prints permission warnings in quiet output without changing marks', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--quiet'],
      {
        harnesses: [
          new FakeHarness(undefined, {
            toolEvents: [SHELL_EVENT, PERMISSION_DENIED_GIT_EVENT],
          }),
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('\n  .\n');
    expect(result.stdout).toContain(
      'WARN  cli-local-runner / uses shell [claude-code]',
    );
    expect(result.stdout).toContain(
      'permission denied for shell command: git commit -m test',
    );
  });

  it('collapses passing scenarios to a one-liner in default mode', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [createPassingHarness()],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('uses shell');
    expect(result.stdout).toContain('✓ 2 assertions');
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
    expect(result.stdout).toContain('uses shell');
    expect(result.stdout).toContain('✓ 2 assertions');
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
    expect(result.stdout).toContain('[ ok ] 2 assertions');
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
    expect(result.stdout).toContain('log       transcript');
    expect(result.stdout).toContain('dynobox-transcript.log');
    expect(result.stdout).toContain('log       chat_jsonl');
    expect(result.stdout).toContain('dynobox-chat-history.jsonl');
    expect(result.stdout).toContain('log       tool_events');
    expect(result.stdout).toContain('dynobox-tool-events.json');
  });

  it('prints newline-delimited JSON with one job record and a summary', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--reporter', 'json'],
      {
        harnesses: [createPassingHarness()],
      },
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schema: 'dynobox.report.v2',
      type: 'job',
      scenario: {name: 'uses shell'},
      harness: {id: 'claude-code'},
      iteration: 1,
      status: 'passed',
      passed: true,
      warnings: [],
      observations: {toolEventCount: 1, httpEventCount: 0},
    });
    expect(records[0]).toHaveProperty('assertions');
    expect(records[1]).toMatchObject({
      schema: 'dynobox.report.v2',
      type: 'summary',
      status: 'passed',
      totals: {jobs: 1, passed: 1, failed: 0, configErrors: 0, warnings: 0},
      plan: {scenarios: 1, harnesses: 1, iterations: 1},
      failedJobs: [],
      warningJobs: [],
    });
    expect(result.stdout).not.toContain('dynobox  1 scenario');
    expect(result.stdout).not.toContain('✓');
  });

  it('preserves configured model metadata when selecting a harness', async () => {
    const configPath = join(fixtures.dir, 'codex-model.config.ts');
    writeFileSync(
      configPath,
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  harnesses: [{id: 'codex', model: 'gpt-5.4-mini', permissionMode: 'dangerous'}],
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    const harness = new CapturingHarness('codex');
    const result = await executeCli(
      ['run', configPath, '--harness', 'codex', '--reporter', 'json'],
      {harnesses: [harness]},
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(records[0]).toMatchObject({
      type: 'job',
      harness: {
        id: 'codex',
        model: 'gpt-5.4-mini',
        permissionMode: 'dangerous',
      },
    });
    expect(records[1]).toMatchObject({
      type: 'summary',
      matrix: {
        harnesses: [
          {id: 'codex', model: 'gpt-5.4-mini', permissionMode: 'dangerous'},
        ],
      },
    });
    expect(harness.inputs[0]).toMatchObject({
      model: 'gpt-5.4-mini',
      permissionMode: 'dangerous',
    });
  });

  it('maps comma-separated model overrides to selected harnesses by index', async () => {
    const configPath = join(fixtures.dir, 'positional-models.config.ts');
    writeFileSync(
      configPath,
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  harnesses: [{id: 'claude-code'}, {id: 'codex'}],
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    const claude = new CapturingHarness('claude-code');
    const codex = new CapturingHarness('codex');
    const result = await executeCli(
      [
        'run',
        configPath,
        '--harness',
        'claude-code,codex',
        '--model',
        'sonnet,gpt-5.5',
        '--reporter',
        'json',
      ],
      {harnesses: [claude, codex]},
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(records.filter((record) => record.type === 'job')).toMatchObject([
      {harness: {id: 'claude-code', model: 'sonnet'}},
      {harness: {id: 'codex', model: 'gpt-5.5'}},
    ]);
    expect(claude.inputs[0]).toMatchObject({model: 'sonnet'});
    expect(codex.inputs[0]).toMatchObject({model: 'gpt-5.5'});
  });

  it('dedupes identical positional harness and model overrides', async () => {
    const configPath = join(fixtures.dir, 'duplicate-models.config.ts');
    writeFileSync(
      configPath,
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  harnesses: [{id: 'codex'}],
  scenarios: [
    {
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    const codex = new CapturingHarness('codex');
    const result = await executeCli(
      [
        'run',
        configPath,
        '--harness',
        'codex,codex',
        '--model',
        'gpt-5.5,gpt-5.5',
        '--reporter',
        'json',
      ],
      {harnesses: [codex]},
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(records.filter((record) => record.type === 'job')).toMatchObject([
      {harness: {id: 'codex', model: 'gpt-5.5'}},
    ]);
    expect(codex.inputs).toHaveLength(1);
    expect(codex.inputs[0]).toMatchObject({model: 'gpt-5.5'});
  });

  it('runs only scenarios matching --scenario filters', async () => {
    const result = await executeCli(
      ['run', fixtures.multiScenarioConfigPath, '--scenario', 'deploy*'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('deploy package');
    expect(result.stdout).not.toContain('lint package');
    expect(result.stdout).toContain(
      '1 dyno · 1 scenario · harness: claude-code',
    );
  });

  it('excludes dynos with no matching scenarios from the discovery summary', async () => {
    const multiDynoDir = join(fixtures.dir, 'multi-dyno-filter');
    mkdirSync(multiDynoDir, {recursive: true});
    writeFileSync(
      join(multiDynoDir, 'alpha.dyno.ts'),
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'alpha-runner',
  scenarios: [
    {
      name: 'alpha test',
      prompt: 'Run alpha.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );
    writeFileSync(
      join(multiDynoDir, 'beta.dyno.ts'),
      `import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'beta-runner',
  scenarios: [
    {
      name: 'beta test',
      prompt: 'Run beta.',
      assertions: [tool.called('shell')],
    },
  ],
});
`,
    );

    const result = await executeCli(
      ['run', multiDynoDir, '--scenario', 'alpha*'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha test');
    expect(result.stdout).not.toContain('beta test');
    expect(result.stdout).not.toContain('beta-runner');
    expect(result.stdout).toContain('1 dyno · 1 scenario');
    expect(result.stdout).not.toContain('2 dynos');
  });

  it('prints an inline sparkline row for repeated iterations', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--iterations', '2'],
      {
        harnesses: [createPassingHarness()],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('iterations: 2');
    expect(result.stdout).toContain('✓ 2/2 passed   ..');
    expect(result.stdout).not.toContain('pass-rate matrix');
    expect(result.stdout).toContain('✓ 2 jobs passed · 4 assertions');
  });

  it('runs each scenario and harness for the requested iterations', async () => {
    const result = await executeCli(
      [
        'run',
        fixtures.validConfigPath,
        '--iterations',
        '3',
        '--reporter',
        'json',
      ],
      {
        harnesses: [createPassingHarness()],
      },
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(records.filter((record) => record.type === 'job')).toHaveLength(3);
    expect(records.map((record) => record.iteration).filter(Boolean)).toEqual([
      1, 2, 3,
    ]);
    expect(records.at(-1)).toMatchObject({
      type: 'summary',
      totals: {jobs: 3, passed: 3, failed: 0},
      plan: {scenarios: 1, harnesses: 1, iterations: 3},
      matrix: {
        cells: [
          {
            scenarioName: 'uses shell',
            passed: 3,
            failed: 0,
            total: 3,
            failedJobs: [],
          },
        ],
      },
    });
  });

  it('runs harness lanes concurrently while preserving ordered JSON results', async () => {
    const tracker = createConcurrencyTracker();
    const result = await executeCli(
      [
        'run',
        fixtures.validConfigPath,
        '--harness',
        'claude-code,codex',
        '--iterations',
        '2',
        '--reporter',
        'json',
      ],
      {
        harnesses: [
          new DelayedHarness('claude-code', 30, tracker),
          new DelayedHarness('codex', 5, tracker),
        ],
      },
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            harness?: {id: string};
            iteration?: number;
            totals?: {durationMs: number};
          },
      );
    const jobRecords = records.filter((record) => record.type === 'job');
    const summary = records.at(-1)!;

    expect(result.exitCode).toBe(0);
    expect(tracker.maxActive).toBe(2);
    expect(tracker.maxActiveByHarness.get('claude-code')).toBe(1);
    expect(tracker.maxActiveByHarness.get('codex')).toBe(1);
    expect(
      jobRecords.map((record) => [record.harness!.id, record.iteration]),
    ).toEqual([
      ['claude-code', 1],
      ['claude-code', 2],
      ['codex', 1],
      ['codex', 2],
    ]);
    expect(summary.totals!.durationMs).toBeLessThan(400);
  });

  it('runs separate models of one harness concurrently', async () => {
    const tracker = createConcurrencyTracker();
    const result = await executeCli(
      [
        'run',
        fixtures.validConfigPath,
        '--harness',
        'codex,codex',
        '--model',
        'gpt-a,gpt-b',
        '--reporter',
        'json',
      ],
      {harnesses: [new DelayedHarness('codex', 20, tracker)]},
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            harness?: {model?: string};
          },
      );

    expect(result.exitCode).toBe(0);
    expect(tracker.maxActiveByHarness.get('codex')).toBe(2);
    expect(
      records
        .filter((record) => record.type === 'job')
        .map((record) => record.harness?.model),
    ).toEqual(['gpt-a', 'gpt-b']);
  });

  it('exits with a config error when no scenarios match --scenario', async () => {
    const result = await executeCli([
      'run',
      fixtures.multiScenarioConfigPath,
      '--scenario',
      'missing*',
    ]);

    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'No scenarios matched --scenario "missing*"',
    );
  });

  it('reports failed jobs as JSON while preserving run failure exit semantics', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--reporter', 'json'],
      {
        harnesses: [
          new FakeHarness(undefined, {toolEvents: [MISMATCHED_SHELL_EVENT]}),
        ],
      },
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(records[0]).toMatchObject({
      type: 'job',
      status: 'assertion_failed',
      passed: false,
    });
    expect(records[1]).toMatchObject({
      type: 'summary',
      status: 'failed',
      totals: {jobs: 1, passed: 0, failed: 1, configErrors: 0},
    });
    const failedJobs = expectStringArray(records[1]?.failedJobs);
    expect(failedJobs[0]).toContain(
      'scenario.uses-shell.claude-code.iteration.0',
    );
  });

  it('reports permission warnings as JSON without changing pass status', async () => {
    const result = await executeCli(
      ['run', fixtures.validConfigPath, '--reporter', 'json'],
      {
        harnesses: [
          new FakeHarness(undefined, {
            toolEvents: [SHELL_EVENT, PERMISSION_DENIED_GIT_EVENT],
          }),
        ],
      },
    );
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(records[0]).toMatchObject({
      type: 'job',
      status: 'passed',
      passed: true,
      warnings: [
        {
          kind: 'permission_denied',
          tool: {
            kind: 'shell',
            rawName: 'Bash',
            command: 'git commit -m test',
          },
        },
      ],
    });
    expect(records[1]).toMatchObject({
      type: 'summary',
      status: 'passed',
      totals: {warnings: 1},
    });
    const warningJobs = expectStringArray(records[1]?.warningJobs);
    expect(warningJobs[0]).toContain(
      'scenario.uses-shell.claude-code.iteration.0',
    );
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
    expect(writes.join('')).toContain('1 job passed');
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

    const toolLines = writes
      .flatMap((value) => value.split('\n'))
      .filter((value) => value.includes('Bash:'));
    expect(result.exitCode).toBe(0);
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toContain(`Bash: pnpm test && git commit -m`);
  });

  it('redraws concurrent harnesses in one live scenario dashboard', async () => {
    const tracker = createConcurrencyTracker();
    const writes: string[] = [];
    const result = await executeCli(
      [
        'run',
        fixtures.validConfigPath,
        '--harness',
        'claude-code,codex',
        '--verbose',
      ],
      {
        harnesses: [
          new DelayedHarness('claude-code', 20, tracker),
          new DelayedHarness('codex', 10, tracker),
        ],
        live: true,
        color: true,
        writeStdout: (value) => writes.push(value),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(tracker.maxActive).toBe(2);
    expect(
      writes.some(
        (value) => value.includes('claude-code') && value.includes('codex'),
      ),
    ).toBe(true);
    expect(writes.join('')).toContain('\x1b[');
    expect(writes.join('')).toContain('2 jobs passed');
    const lastDashboardClear = writes
      .map((value) => value.includes('\x1b[J'))
      .lastIndexOf(true);
    const committedOutput = writes.slice(lastDashboardClear + 1).join('');
    expect(committedOutput).toContain('setup');
    expect(committedOutput).toContain('harness');
    expect(committedOutput).toContain('assertions');
  });

  it('prints permission warnings when live output completes', async () => {
    const writes: string[] = [];
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [
        new FakeHarness(undefined, {
          toolEvents: [SHELL_EVENT, PERMISSION_DENIED_GIT_EVENT],
        }),
      ],
      live: true,
      writeStdout: (value) => writes.push(value),
    });

    expect(result.exitCode).toBe(0);
    expect(writes.join('')).toContain(
      'warning permission denied for shell command: git commit -m test',
    );
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
    expect(result.stdout).toContain('✗ 1 of 2 failed');
    expect(result.stdout).toContain(
      '✗ tool.called(shell, includes: pnpm test)',
    );
    expect(result.stdout).not.toContain('✓ tool.called(shell)');
    expect(result.stdout).toContain(
      'expected  shell command including "pnpm test"',
    );
    expect(result.stdout).toContain('observed shell commands during this run:');
    expect(result.stdout).toContain('1. npm test');
    expect(result.stdout).toContain(
      '✗ 1 of 1 jobs failed · 1 failed assertion',
    );
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
    expect(result.stdout).toContain('✓ skill.referenced(commit)');
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

  it('shows observed skill files when skill reference assertions fail', async () => {
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
    expect(result.stdout).toContain('✗ skill.referenced(commit)');
    expect(result.stdout).toContain(
      'expected  skill "commit" instruction file reference',
    );
    expect(result.stdout).toContain(
      'observed  no matching SKILL.md reference observed',
    );
    expect(result.stdout).toContain('observed skill files during this run:');
    expect(result.stdout).toContain(`1. ${RELEASE_SKILL_PATH}`);
  });

  it('shows no observed skill files when skill reference evidence is absent', async () => {
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
    expect(result.stdout).toContain('setup breaks');
    expect(result.stdout).toContain('✗ setup failed');
    expect(result.stdout).toContain('$ echo setup failed >&2 && exit 7');
    expect(result.stdout).toContain('exit code 7');
    expect(result.stdout).toContain('✗ 1 job error');
  });

  it('exits nonzero with diagnostics when no harness is registered', async () => {
    const result = await executeCli(['run', fixtures.validConfigPath], {
      harnesses: [],
    });

    expect(result.exitCode).toBe(runFailureExitCode);
    expect(result.stdout).toContain('✗ harness failed');
    expect(result.stdout).toContain(
      'No harness registered for scenario harness "claude-code".',
    );
    expect(result.stdout).toContain('✗ 1 job error');
    expect(result.stderr).toBe('');
  });
});
