import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';

import type {IrScenario} from '@dynobox/sdk';
import {afterEach, describe, expect, it} from 'vitest';

import {FakeHarness} from './harnesses/fake.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './harnesses/index.js';
import {type LocalRunnerJob, runJob} from './index.js';

const scratchRoots: string[] = [];

function createScratchRoot(): string {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'dynobox-runner-test-'));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

afterEach(() => {
  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, {force: true, recursive: true});
  }
});

function createJob(scenario: Partial<IrScenario> = {}): LocalRunnerJob {
  return {
    id: 'job.uses-shell.0',
    iteration: 0,
    scenario: {
      id: 'scenario.uses-shell',
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      harness: 'claude-code',
      setup: [],
      endpoints: [],
      assertions: [],
      ...scenario,
    },
  };
}

class RecordingHarness implements Harness {
  readonly id = 'claude-code' as const;

  readonly inputs: HarnessInput[] = [];
  setupMarkerExistsAtRun = false;

  constructor(
    private readonly response: HarnessRunOutput = {
      exitCode: 0,
      stdout: 'fake output',
      stderr: '',
      durationMs: 100,
    },
    private readonly toolEvents: ToolEvent[] = [],
  ) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    this.inputs.push(input);
    this.setupMarkerExistsAtRun = existsSync(join(input.workDir, 'setup.txt'));
    return this.response;
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout || undefined,
      toolEvents: this.toolEvents,
    };
  }
}

class ThrowingHarness implements Harness {
  readonly id = 'claude-code' as const;

  async run(_input: HarnessInput): Promise<HarnessRunOutput> {
    throw new Error('agent crashed');
  }

  extractResult(_raw: HarnessRunOutput): HarnessResult {
    throw new Error('unreachable');
  }
}

describe('runJob', () => {
  it('creates a work directory under scratchRoot and returns it as an artifact', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [new RecordingHarness()],
    });

    expect(result.status).toBe('passed');
    expect(result.passed).toBe(true);
    expect(existsSync(result.workDir)).toBe(true);
    expect(relative(scratchRoot, result.workDir)).toMatch(/^dynobox-job-/);
    expect(result.artifacts).toEqual([
      {kind: 'work_dir', path: result.workDir},
    ]);
  });

  it('runs setup before invoking the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      createJob({
        setup: [
          "node -e \"require('node:fs').writeFileSync('setup.txt', 'ready')\"",
        ],
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('passed');
    expect(result.setupResult.success).toBe(true);
    expect(result.setupResult.logs).toHaveLength(1);
    expect(harness.inputs).toHaveLength(1);
    expect(harness.setupMarkerExistsAtRun).toBe(true);
  });

  it('passes prompt, workDir, env, and timeout to the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();
    const env = {DYNOBOX_TEST_ENV: 'available'};

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [harness],
      env,
      timeoutMs: 1234,
    });

    expect(result.status).toBe('passed');
    expect(harness.inputs[0]).toMatchObject({
      prompt: 'Run pnpm test.',
      workDir: result.workDir,
      env,
      timeoutMs: 1234,
    });
  });

  it('works with FakeHarness and passing tool assertions', async () => {
    const scratchRoot = createScratchRoot();
    const shellEvent: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    };
    const harness = new FakeHarness(undefined, {toolEvents: [shellEvent]});

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'pnpm test'},
          },
        ],
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults).toHaveLength(1);
    expect(result.assertionResults[0]).toMatchObject({passed: true});
    expect(result.harnessResult?.toolEvents).toEqual([shellEvent]);
  });

  it('returns assertion_failed when assertions fail', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'tool.called',
            toolKind: 'shell',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('assertion_failed');
    expect(result.passed).toBe(false);
    expect(result.assertionResults).toHaveLength(1);
    expect(result.assertionResults[0]).toMatchObject({
      passed: false,
      message: 'Expected tool "shell" to be called, but observed none.',
    });
  });

  it('represents unsupported HTTP assertions as assertion results', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        endpoints: [
          {
            id: 'endpoint.uses-shell.getUser',
            key: 'getUser',
            method: 'GET',
            url: 'https://api.example.com/user',
          },
        ],
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'http.called',
            endpointId: 'endpoint.uses-shell.getUser',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('assertion_failed');
    expect(result.diagnostics).toEqual([]);
    expect(result.assertionResults[0]).toMatchObject({
      kind: 'http.called',
      passed: false,
      message:
        'Assertion kind "http.called" is not supported by this evaluator.',
    });
  });

  it('short-circuits setup failures before invoking the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      createJob({setup: ['echo setup failed >&2 && exit 7']}),
      {
        scratchRoot,
        harnesses: [harness],
      },
    );

    expect(result.status).toBe('setup_failed');
    expect(result.passed).toBe(false);
    expect(result.setupResult.success).toBe(false);
    expect(result.setupResult.logs[0]?.exitCode).toBe(7);
    expect(result.diagnostics[0]).toContain('setup failed');
    expect(harness.inputs).toHaveLength(0);
    expect(result.harnessOutput).toBeUndefined();
  });

  it('returns harness_failed when no harness is registered', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(createJob(), {scratchRoot});

    expect(result.status).toBe('harness_failed');
    expect(result.passed).toBe(false);
    expect(result.diagnostics).toEqual([
      'No harness registered for scenario harness "claude-code".',
    ]);
  });

  it('returns harness_failed when harness invocation throws', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [new ThrowingHarness()],
    });

    expect(result.status).toBe('harness_failed');
    expect(result.diagnostics).toEqual([
      'Harness "claude-code" failed to run: agent crashed',
    ]);
    expect(result.harnessOutput).toBeUndefined();
  });

  it('returns harness_failed when harness exits nonzero', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness({
      exitCode: 2,
      stdout: '',
      stderr: 'agent failed',
      durationMs: 50,
    });

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [harness],
    });

    expect(result.status).toBe('harness_failed');
    expect(result.assertionResults).toEqual([]);
    expect(result.harnessOutput).toMatchObject({
      exitCode: 2,
      stderr: 'agent failed',
    });
    expect(result.harnessResult).toMatchObject({exitCode: 2});
    expect(result.diagnostics).toEqual([
      'Harness exited with code 2: agent failed',
    ]);
  });
});
