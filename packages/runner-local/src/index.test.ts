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
import {
  type LocalRunnerJob,
  runJob,
  type RunJobProgressEvent,
} from './index.js';

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

class ToolStreamingHarness implements Harness {
  readonly id = 'claude-code' as const;

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    input.onToolEvent?.({
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    } as ShellToolEvent);

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
      toolEvents: [
        {
          kind: 'shell',
          rawName: 'Bash',
          input: {command: 'pnpm test'},
          command: 'pnpm test',
        } as ShellToolEvent,
      ],
    };
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
    expect(result.timing).toMatchObject({
      setupMs: 0,
      harnessMs: 100,
    });
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(100);
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
    expect(result.timing).toMatchObject({
      setupMs: 0,
      harnessMs: 100,
    });
    expect(result.harnessResult?.toolEvents).toEqual([shellEvent]);
  });

  it('evaluates artifact assertions against the job work directory', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        setup: [
          "node -e \"require('node:fs').writeFileSync('CHANGELOG.md', 'dynobox@0.0.4')\"",
        ],
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'artifact.contains',
            path: 'CHANGELOG.md',
            text: 'dynobox@0.0.4',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({passed: true});
  });

  it('evaluates harness transcript and final message assertions', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'transcript.contains',
            text: 'EOTP',
          },
          {
            id: 'assertion.uses-shell.1',
            kind: 'finalMessage.contains',
            text: 'working tree is dirty',
          },
        ],
      }),
      {
        scratchRoot,
        harnesses: [
          new FakeHarness({stdout: 'transcript EOTP\nworking tree is dirty'}),
        ],
      },
    );

    expect(result.status).toBe('passed');
    expect(
      result.assertionResults.map((assertion) => assertion.passed),
    ).toEqual([true, true]);
  });

  it('evaluates ordered shell sequences through runJob', async () => {
    const scratchRoot = createScratchRoot();
    const toolEvents: ShellToolEvent[] = [
      {
        kind: 'shell',
        rawName: 'Bash',
        input: {command: 'git status'},
        command: 'git status',
      },
      {
        kind: 'shell',
        rawName: 'Bash',
        input: {command: 'git commit -m test'},
        command: 'git commit -m test',
      },
    ];

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'sequence.inOrder',
            steps: [
              {
                kind: 'tool.called',
                toolKind: 'shell',
                matcher: {includes: 'git status'},
              },
              {
                kind: 'tool.called',
                toolKind: 'shell',
                matcher: {includes: 'git commit'},
              },
            ],
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness(undefined, {toolEvents})]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({passed: true});
  });

  it('emits progress events for a passing job', async () => {
    const scratchRoot = createScratchRoot();
    const events: RunJobProgressEvent[] = [];
    const shellEvent: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    };

    const result = await runJob(
      createJob({
        setup: ['node --version'],
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            kind: 'tool.called',
            toolKind: 'shell',
          },
        ],
      }),
      {
        scratchRoot,
        harnesses: [new FakeHarness(undefined, {toolEvents: [shellEvent]})],
        onProgress: (event) => events.push(event),
      },
    );

    expect(result.status).toBe('passed');
    expect(events.map((event) => event.type)).toEqual([
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.completed',
      'assertions.started',
      'assertions.completed',
    ]);
    expect(events[0]).toMatchObject({commandCount: 1});
    expect(events[3]).toMatchObject({
      harnessId: 'claude-code',
      success: true,
      exitCode: 0,
      durationMs: 100,
    });
    expect(events[4]).toMatchObject({assertionCount: 1});
    expect(events[5]).toMatchObject({
      assertionResults: [{passed: true}],
    });
  });

  it('re-emits live harness tool events with a running count', async () => {
    const scratchRoot = createScratchRoot();
    const events: RunJobProgressEvent[] = [];

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
      {
        scratchRoot,
        harnesses: [new ToolStreamingHarness()],
        onProgress: (event) => events.push(event),
      },
    );

    expect(result.status).toBe('passed');
    expect(events.map((event) => event.type)).toEqual([
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.tool',
      'harness.completed',
      'assertions.started',
      'assertions.completed',
    ]);
    expect(events[3]).toMatchObject({
      type: 'harness.tool',
      harnessId: 'claude-code',
      toolCount: 1,
      toolEvent: {kind: 'shell', command: 'pnpm test'},
    });
    expect(events[4]).toMatchObject({
      type: 'harness.completed',
      toolCount: 1,
    });
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
    expect(result.timing.harnessMs).toBe(0);
    expect(result.timing.assertionsMs).toBe(0);
    expect(result.diagnostics[0]).toContain('setup failed');
    expect(harness.inputs).toHaveLength(0);
    expect(result.harnessOutput).toBeUndefined();
  });

  it('returns harness_failed when no harness is registered', async () => {
    const scratchRoot = createScratchRoot();
    const events: RunJobProgressEvent[] = [];

    const result = await runJob(createJob(), {
      scratchRoot,
      onProgress: (event) => events.push(event),
    });

    expect(result.status).toBe('harness_failed');
    expect(result.passed).toBe(false);
    expect(result.timing).toMatchObject({
      setupMs: 0,
      harnessMs: 0,
      assertionsMs: 0,
      totalMs: 0,
    });
    expect(result.diagnostics).toEqual([
      'No harness registered for scenario harness "claude-code".',
    ]);
    expect(events.map((event) => event.type)).toEqual([
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.completed',
    ]);
    expect(events[3]).toMatchObject({
      harnessId: 'claude-code',
      success: false,
    });
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
    expect(result.timing).toMatchObject({
      setupMs: 0,
      harnessMs: 50,
      assertionsMs: 0,
      totalMs: 50,
    });
    expect(result.diagnostics).toEqual([
      'Harness exited with code 2: agent failed',
    ]);
  });
});
