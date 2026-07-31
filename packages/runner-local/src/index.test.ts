import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {delimiter, join, relative} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
import {execaCommand} from 'execa';
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
      fixtures: [],
      cliMocks: {},
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
    private readonly probeVersion: () => Promise<string | null> = async () =>
      null,
    private readonly onRun: () => void = () => undefined,
  ) {}

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    this.onRun();
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

class CommandHarness implements Harness {
  readonly id = 'claude-code' as const;
  readonly inputs: HarnessInput[] = [];

  constructor(
    private readonly command: string,
    readonly executable = 'claude',
  ) {}

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    this.inputs.push(input);
    const startedAt = Date.now();
    const result = await execaCommand(this.command, {
      cwd: input.workDir,
      env: {...process.env, ...input.env},
      reject: false,
      shell: true,
      ...(input.timeoutMs === undefined ? {} : {timeout: input.timeoutMs}),
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: raw.stdout || undefined,
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

  it('records a harness version without failing the run when discovery fails', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness(undefined, [], async () => {
      throw new Error('version unavailable');
    });

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [harness],
    });

    expect(result).toMatchObject({status: 'passed', harnessVersion: null});
  });

  it('probes the harness version without delaying harness execution', async () => {
    const scratchRoot = createScratchRoot();
    let releaseVersion: ((version: string) => void) | undefined;
    const version = new Promise<string>((resolve) => {
      releaseVersion = resolve;
    });
    let markRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const harness = new RecordingHarness(
      undefined,
      [],
      () => version,
      () => markRunStarted?.(),
    );

    const run = runJob(createJob(), {scratchRoot, harnesses: [harness]});
    const startedBeforeVersion = await Promise.race([
      runStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseVersion?.('1.2.3');
    const result = await run;

    expect(startedBeforeVersion).toBe(true);
    expect(result.harnessVersion).toBe('1.2.3');
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

  it('uses the real PATH for setup and the mocked PATH for the harness', async () => {
    const scratchRoot = createScratchRoot();
    const realBin = join(scratchRoot, 'real-bin');
    const executable = join(realBin, 'mocked-cli');
    mkdirSync(realBin, {recursive: true});
    writeFileSync(executable, '#!/bin/sh\nprintf real', {
      mode: 0o755,
    });
    const harness = new CommandHarness('mocked-cli harness');
    const originalPath = process.env.PATH;

    const result = await runJob(
      createJob({
        setup: ['mocked-cli > setup.txt'],
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: 'mocked', stderr: ''},
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [harness],
        env: {PATH: `${realBin}${delimiter}${process.env.PATH ?? ''}`},
      },
    );

    expect(result.status).toBe('passed');
    expect(readFileSync(join(result.workDir, 'setup.txt'), 'utf8')).toBe(
      'real',
    );
    expect(result.harnessOutput?.stdout).toBe('mocked');
    expect(result.cliMockCalls).toEqual([
      expect.objectContaining({
        executable: 'mocked-cli',
        argv: ['harness'],
        stdout: 'mocked',
      }),
    ]);
    expect(existsSync(join(result.workDir, '.dynobox'))).toBe(false);
    expect(process.env.PATH).toBe(originalPath);
  });

  it('preserves a package script shell configured by project npmrc', async () => {
    const scratchRoot = createScratchRoot();
    const setupProject = `node -e 'const fs=require("node:fs");const path=require("node:path");fs.writeFileSync("package.json",JSON.stringify({scripts:{test:"mocked-cli package"}}));fs.writeFileSync("custom-shell","#!/bin/sh\\nprintf configured > shell-marker\\nexec /bin/sh \\"$@\\"\\n",{mode:0o755});fs.writeFileSync(".npmrc","script-shell="+path.join(process.cwd(),"custom-shell")+"\\n")'`;

    const result = await runJob(
      createJob({
        setup: [setupProject],
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: 'mocked', stderr: ''},
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [new CommandHarness('npm run test --silent')],
      },
    );

    expect(result.status).toBe('passed');
    expect(result.harnessOutput?.stdout).toBe('mocked');
    expect(readFileSync(join(result.workDir, 'shell-marker'), 'utf8')).toBe(
      'configured',
    );
  });

  it('ignores empty npm script-shell sentinel values', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        setup: [
          `node -e 'require("node:fs").writeFileSync("package.json",JSON.stringify({scripts:{test:"mocked-cli package"}}))'`,
        ],
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: 'mocked', stderr: ''},
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [new CommandHarness('npm run test --silent')],
        env: {NPM_CONFIG_SCRIPT_SHELL: 'null'},
      },
    );

    expect(result.status).toBe('passed');
    expect(result.harnessOutput?.stdout).toBe('mocked');
  });

  it('provides CLI mocks to verification commands', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: 'verified', stderr: ''},
          },
        },
        assertions: [
          {
            id: 'assertion.verify.0',
            type: 'verify.command',
            command: 'mocked-cli verify',
            exitCode: 0,
            stdout: {equals: 'verified'},
          },
        ],
      }),
      {scratchRoot, harnesses: [new RecordingHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.cliMockCalls).toEqual([
      expect.objectContaining({
        executable: 'mocked-cli',
        argv: ['verify'],
      }),
    ]);
  });

  it('uses only harness-phase CLI mock calls for observation assertions', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: '', stderr: ''},
          },
        },
        assertions: [
          {
            id: 'assertion.command.0',
            type: 'command.called',
            executable: 'mocked-cli',
            command: {args: ['harness']},
          },
          {
            id: 'assertion.command.1',
            type: 'command.notCalled',
            executable: 'mocked-cli',
            command: {args: ['verify']},
          },
          {
            id: 'assertion.verify.0',
            type: 'verify.command',
            command: 'mocked-cli verify',
            exitCode: 0,
          },
        ],
      }),
      {
        scratchRoot,
        harnesses: [new CommandHarness('mocked-cli harness')],
      },
    );

    expect(result.status).toBe('passed');
    expect(
      result.assertionResults.map((assertion) => assertion.passed),
    ).toEqual([true, true, true]);
    expect(result.cliMockCalls.map((call) => call.argv)).toEqual([
      ['harness'],
      ['verify'],
    ]);
  });

  it('rejects a CLI mock that collides with the harness executable', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new CommandHarness('mocked-cli', 'mocked-cli');
    const events: RunJobProgressEvent[] = [];

    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            response: {exitCode: 0, stdout: '', stderr: ''},
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [harness],
        onProgress: (event) => events.push(event),
      },
    );

    expect(result.status).toBe('harness_failed');
    expect(result.diagnostics[0]).toContain('conflicts with harness');
    expect(harness.inputs).toEqual([]);
    expect(
      events.filter((event) => event.type.startsWith('harness.')),
    ).toMatchObject([
      {type: 'harness.started'},
      {type: 'harness.completed', success: false},
    ]);
  });

  it('reports CLI mock initialization errors as harness failures', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      createJob({
        cliMocks: {
          'invalid/name': {
            response: {exitCode: 0, stdout: '', stderr: ''},
          },
        },
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('harness_failed');
    expect(result.diagnostics[0]).toContain('CLI mocks failed to initialize');
    expect(harness.inputs).toEqual([]);
  });

  it('fails the harness when it ignores CLI mock exhaustion', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            responses: [{exitCode: 0, stdout: '', stderr: ''}],
            onExhausted: 'error',
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [
          new CommandHarness(
            'mocked-cli first; mocked-cli second >/dev/null 2>&1 || true',
          ),
        ],
      },
    );

    expect(result.harnessOutput?.exitCode).toBe(0);
    expect(result.status).toBe('harness_failed');
    expect(result.cliMockCalls).toHaveLength(2);
    expect(result.diagnostics[0]).toContain('exhausted');
  });

  it('fails and records a CLI mock still pending when the harness exits', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            handler: async ({cwd}) => {
              writeFileSync(join(cwd, 'handler-started'), '');
              return new Promise<never>(() => undefined);
            },
          },
        },
      }),
      {
        scratchRoot,
        harnesses: [
          new CommandHarness(
            'mocked-cli pending >/dev/null 2>&1 & while [ ! -f handler-started ]; do sleep 0.01; done',
          ),
        ],
      },
    );

    expect(result.status).toBe('harness_failed');
    expect(result.cliMockCalls).toEqual([
      expect.objectContaining({
        executable: 'mocked-cli',
        argv: ['pending'],
        exitCode: 1,
      }),
    ]);
    expect(result.diagnostics[0]).toContain('did not complete');
  });

  it('preserves verification mock failures even when assertions accept the exit code', async () => {
    const scratchRoot = createScratchRoot();
    const result = await runJob(
      createJob({
        cliMocks: {
          'mocked-cli': {
            responses: [{exitCode: 0, stdout: '', stderr: ''}],
            onExhausted: 'error',
          },
        },
        assertions: [
          {
            id: 'assertion.verify.0',
            type: 'verify.command',
            command: 'mocked-cli first',
            exitCode: 0,
          },
          {
            id: 'assertion.verify.1',
            type: 'verify.command',
            command: 'mocked-cli second',
            exitCode: 1,
          },
        ],
      }),
      {scratchRoot, harnesses: [new RecordingHarness()]},
    );

    expect(result.assertionResults.every((assertion) => assertion.passed)).toBe(
      true,
    );
    expect(result.status).toBe('assertion_failed');
    expect(result.diagnostics[0]).toContain('exhausted');
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

  it('runs verify.command assertions after a successful harness', async () => {
    const scratchRoot = createScratchRoot();
    const command =
      'node -e "process.stdout.write(process.env.DYNOBOX_TEST_ENV ?? \'\')"';

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.verify.0',
            type: 'verify.command',
            command,
            exitCode: 0,
            stdout: {equals: 'available'},
          },
        ],
      }),
      {
        scratchRoot,
        harnesses: [new RecordingHarness()],
        env: {DYNOBOX_TEST_ENV: 'available'},
      },
    );

    expect(result.status).toBe('passed');
    expect(result.harnessResult?.toolEvents).toEqual([]);
    expect(result.assertionResults[0]).toMatchObject({
      assertionId: 'assertion.verify.0',
      type: 'verify.command',
      passed: true,
      evidence: {
        command,
        exitCode: 0,
        stdout: 'available',
        stderr: '',
      },
    });
  });

  it('evaluates artifact assertions before running verify.command assertions', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.artifact.0',
            type: 'artifact.exists',
            path: 'created.txt',
          },
          {
            id: 'assertion.verify.0',
            type: 'verify.command',
            command:
              "node -e \"require('node:fs').writeFileSync('created.txt', 'created')\"",
            exitCode: 0,
          },
        ],
      }),
      {scratchRoot, harnesses: [new RecordingHarness()]},
    );

    expect(result.status).toBe('assertion_failed');
    expect(result.assertionResults).toMatchObject([
      {assertionId: 'assertion.artifact.0', passed: false},
      {assertionId: 'assertion.verify.0', passed: true},
    ]);
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
            type: 'tool.called',
            tool: 'shell',
            command: {includes: 'pnpm test'},
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

  it('passes anyOf when a branch matches observed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const shellEvent: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'cat package.json'},
      command: 'cat package.json',
    };
    const harness = new FakeHarness(undefined, {toolEvents: [shellEvent]});

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.flexible-read.0',
            type: 'anyOf',
            steps: [
              {
                type: 'tool.called',
                tool: 'read_file',
                path: 'package.json',
              },
              {
                type: 'command.called',
                executable: 'cat',
                command: {args: ['package.json']},
              },
            ],
          },
        ],
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({
      passed: true,
      evidence: {kind: 'anyOf', branchIndex: 2},
    });
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
            type: 'artifact.contains',
            path: 'CHANGELOG.md',
            text: 'dynobox@0.0.4',
          },
          {
            id: 'assertion.uses-shell.1',
            type: 'artifact.notExists',
            path: 'scratch.tmp',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults.map((entry) => entry.passed)).toEqual([
      true,
      true,
    ]);
  });

  it('captures artifact.unchanged baselines before the harness runs', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness(undefined, []);
    // Mutate the file during the harness run after setup wrote the baseline.
    harness.run = async (input) => {
      const {writeFileSync} = await import('node:fs');
      writeFileSync(join(input.workDir, 'stable.txt'), 'changed');
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 10,
      };
    };

    const result = await runJob(
      createJob({
        setup: [
          "node -e \"require('node:fs').writeFileSync('stable.txt', 'baseline')\"",
        ],
        assertions: [
          {
            id: 'assertion.stable.0',
            type: 'artifact.unchanged',
            path: 'stable.txt',
          },
        ],
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(result.status).toBe('assertion_failed');
    expect(result.assertionResults[0]).toMatchObject({
      passed: false,
      message: expect.stringContaining('contents differ'),
    });
  });

  it('passes artifact.unchanged when the harness leaves the file byte-identical', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        setup: [
          "node -e \"require('node:fs').writeFileSync('stable.txt', 'baseline')\"",
        ],
        assertions: [
          {
            id: 'assertion.stable.0',
            type: 'artifact.unchanged',
            path: 'stable.txt',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({passed: true});
  });

  it('keeps invalid artifact.unchanged baselines assertion-level without blocking the harness', async () => {
    const scratchRoot = createScratchRoot();
    const harness = new RecordingHarness();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.stable.0',
            type: 'artifact.unchanged',
            path: 'missing.txt',
          },
        ],
      }),
      {scratchRoot, harnesses: [harness]},
    );

    expect(harness.inputs).toHaveLength(1);
    expect(result.status).toBe('assertion_failed');
    expect(result.assertionResults[0]?.message).toContain(
      'before the harness started',
    );
  });

  it('runs nested anyOf verification branches without mutating observation results', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.flexible.0',
            type: 'anyOf',
            steps: [
              {type: 'artifact.notExists', path: 'created.txt'},
              {
                type: 'verify.command',
                command:
                  "node -e \"require('node:fs').writeFileSync('created.txt', 'created')\"",
                exitCode: 0,
              },
            ],
          },
        ],
      }),
      {scratchRoot, harnesses: [new RecordingHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({
      passed: true,
      // Observation branch was cached before verify created the file.
      evidence: {kind: 'anyOf', branchIndex: 1},
    });
  });

  it('passes anyOf via nested verify when observation branches fail', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.flexible.0',
            type: 'anyOf',
            steps: [
              {type: 'artifact.exists', path: 'missing.txt'},
              {
                type: 'verify.command',
                command: 'node -e "process.exit(0)"',
                exitCode: 0,
              },
            ],
          },
        ],
      }),
      {scratchRoot, harnesses: [new RecordingHarness()]},
    );

    expect(result.status).toBe('passed');
    expect(result.assertionResults[0]).toMatchObject({
      passed: true,
      evidence: {kind: 'anyOf', branchIndex: 2},
    });
  });

  it('evaluates harness transcript and final message assertions', async () => {
    const scratchRoot = createScratchRoot();

    const result = await runJob(
      createJob({
        assertions: [
          {
            id: 'assertion.uses-shell.0',
            type: 'transcript.contains',
            text: 'EOTP',
          },
          {
            id: 'assertion.uses-shell.1',
            type: 'finalMessage.contains',
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
            type: 'sequence.inOrder',
            steps: [
              {
                type: 'tool.called',
                tool: 'shell',
                command: {includes: 'git status'},
              },
              {
                type: 'tool.called',
                tool: 'shell',
                command: {includes: 'git commit'},
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
            type: 'tool.called',
            tool: 'shell',
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
      'fixtures.started',
      'fixtures.completed',
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.completed',
      'assertions.started',
      'assertions.completed',
    ]);
    expect(events[2]).toMatchObject({commandCount: 1});
    expect(events[5]).toMatchObject({
      harnessId: 'claude-code',
      success: true,
      exitCode: 0,
      durationMs: 100,
    });
    expect(events[6]).toMatchObject({assertionCount: 1});
    expect(events[7]).toMatchObject({
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
            type: 'tool.called',
            tool: 'shell',
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
      'fixtures.started',
      'fixtures.completed',
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.tool',
      'harness.completed',
      'assertions.started',
      'assertions.completed',
    ]);
    expect(events[5]).toMatchObject({
      type: 'harness.tool',
      harnessId: 'claude-code',
      toolCount: 1,
      toolEvent: {kind: 'shell', command: 'pnpm test'},
    });
    expect(events[6]).toMatchObject({
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
            type: 'tool.called',
            tool: 'shell',
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

  it('recognizes OpenCode permission rejection warnings', async () => {
    const scratchRoot = createScratchRoot();
    const rejectedEdit: ToolEvent = {
      kind: 'edit_file',
      rawName: 'apply_patch',
      input: {patchText: '*** Begin Patch'},
      status: 'failure',
      message: 'The user rejected permission to use this specific tool call.',
    };

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [new FakeHarness(undefined, {toolEvents: [rejectedEdit]})],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: 'permission_denied',
      tool: {kind: 'edit_file', rawName: 'apply_patch'},
    });
  });

  it('recognizes explicit OpenCode deny-rule warnings', async () => {
    const scratchRoot = createScratchRoot();
    const deniedEdit: ToolEvent = {
      kind: 'edit_file',
      rawName: 'apply_patch',
      input: {patchText: '*** Begin Patch'},
      status: 'failure',
      message:
        'The user has specified a rule which prevents you from using this specific tool call.',
    };

    const result = await runJob(createJob(), {
      scratchRoot,
      harnesses: [new FakeHarness(undefined, {toolEvents: [deniedEdit]})],
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('permission_denied');
  });

  it('does not warn for ordinary failed tool events', async () => {
    const scratchRoot = createScratchRoot();
    const failedTestCommand: ShellToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
      status: 'failure',
      message: 'A lint rule blocks this build.',
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
            type: 'http.called',
            endpointId: 'endpoint.uses-shell.getUser',
          },
        ],
      }),
      {scratchRoot, harnesses: [new FakeHarness()]},
    );

    expect(result.status).toBe('assertion_failed');
    expect(result.diagnostics).toEqual([]);
    expect(result.assertionResults[0]).toMatchObject({
      type: 'http.called',
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
              type: 'http.called',
              endpointId: 'endpoint.uses-http.getUser',
              status: 204,
            },
            {
              id: 'assertion.uses-http.1',
              type: 'http.notCalled',
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
      'fixtures.started',
      'fixtures.completed',
      'setup.started',
      'setup.completed',
      'harness.started',
      'harness.completed',
    ]);
    expect(events[5]).toMatchObject({
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
