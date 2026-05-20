import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
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
    harness: 'claude-code',
    scenario: {
      id: 'scenario.uses-shell',
      name: 'uses shell',
      prompt: 'Run pnpm test.',
      harnesses: [{id: 'claude-code'}],
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

class ProxyRequestHarness implements Harness {
  readonly id = 'claude-code' as const;

  constructor(private readonly targetUrl: string) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const proxyUrl = input.env.HTTP_PROXY;
    if (proxyUrl === undefined) {
      throw new Error('HTTP_PROXY was not provided');
    }

    await requestThroughProxy(proxyUrl, this.targetUrl);
    return {
      exitCode: 0,
      stdout: 'fetched endpoint',
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
      toolEvents: [],
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

  it('passes the job model to the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      {...createJob(), model: 'sonnet'},
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('passed');
    expect(result.model).toBe('sonnet');
    expect(harness.inputs[0]).toMatchObject({model: 'sonnet'});
  });

  it('passes the job permission mode to the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      {...createJob(), permissionMode: 'dangerous'},
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('passed');
    expect(result.permissionMode).toBe('dangerous');
    expect(harness.inputs[0]).toMatchObject({permissionMode: 'dangerous'});
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

  it('adds permission warnings without changing pass/fail status', async () => {
    const scratchRoot = createScratchRoot();
    const deniedGitCommit: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git commit -m test'},
      command: 'git commit -m test',
      status: 'failure',
      message: 'Permission denied',
    };

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [new FakeHarness(undefined, {toolEvents: [deniedGitCommit]})],
    });

    expect(result.status).toBe('passed');
    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual([
      {
        kind: 'permission_denied',
        message:
          'Harness blocked a tool action. Use --permission-mode dangerous only for trusted evals that intentionally need this access.',
        tool: {
          kind: 'shell',
          rawName: 'Bash',
          command: 'git commit -m test',
        },
      },
    ]);
  });

  it('does not warn for ordinary failed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const failedTestCommand: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
      status: 'failure',
      message: 'Tests failed',
    };

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [
        new FakeHarness(undefined, {toolEvents: [failedTestCommand]}),
      ],
    });

    expect(result.status).toBe('passed');
    expect(result.warnings).toEqual([]);
  });

  it('represents unmet HTTP assertions as assertion results', async () => {
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
        'Expected HTTP endpoint "endpoint.uses-shell.getUser" to be called, but observed none.',
    });
  });

  it('captures HTTP requests and evaluates HTTP assertions', async () => {
    const scratchRoot = createScratchRoot();
    const upstream = await startHttpServer(204);
    const targetUrl = `http://127.0.0.1:${upstream.port}/user`;

    try {
      const result = await runJob(
        createJob({
          endpoints: [
            {
              id: 'endpoint.uses-http.getUser',
              key: 'getUser',
              method: 'GET',
              url: targetUrl,
            },
            {
              id: 'endpoint.uses-http.deleteUser',
              key: 'deleteUser',
              method: 'DELETE',
              url: targetUrl,
            },
          ],
          assertions: [
            {
              id: 'assertion.uses-http.0',
              kind: 'http.called',
              endpointId: 'endpoint.uses-http.getUser',
              status: 204,
            },
            {
              id: 'assertion.uses-http.1',
              kind: 'http.notCalled',
              endpointId: 'endpoint.uses-http.deleteUser',
            },
          ],
        }),
        {
          scratchRoot,
          harnesses: [new ProxyRequestHarness(targetUrl)],
        },
      );

      expect(result.status).toBe('passed');
      expect(result.httpEvents).toHaveLength(1);
      expect(result.httpEvents[0]).toMatchObject({
        endpointId: 'endpoint.uses-http.getUser',
        method: 'GET',
        url: targetUrl,
        status: 204,
      });
      expect(
        result.assertionResults.map((assertion) => assertion.passed),
      ).toEqual([true, true]);
    } finally {
      await upstream.close();
    }
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

async function startHttpServer(
  statusCode: number,
): Promise<{port: number; close(): Promise<void>}> {
  const server = createServer((_req, res) => {
    res.statusCode = statusCode;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }

  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

function requestThroughProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<void> {
  const proxy = new URL(proxyUrl);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: targetUrl,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
