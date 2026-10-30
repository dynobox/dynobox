import {access} from 'node:fs/promises';
import {dirname} from 'node:path';
import {PassThrough} from 'node:stream';
import {pathToFileURL} from 'node:url';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {piToolNames, runPiWithMcp} from './piMcp.js';

const mocks = vi.hoisted(() => ({execa: vi.fn()}));
vi.mock('execa', () => ({
  execa: (...args: unknown[]) =>
    Object.assign(mocks.execa(...args), {
      kill: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    }),
}));

const finalMessage = JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{type: 'text', text: 'READY'}],
    stopReason: 'stop',
  },
});
let bridge: string | undefined;
const options = () => ({
  executable: process.execPath,
  input: {
    workDir: process.cwd(),
    env: {NO_PROXY: 'upper', no_proxy: 'lower'},
    prompt: 'Say READY',
    timeoutMs: 5000,
  },
  servers: {
    linear: {url: 'http://127.0.0.1:12345/linear', tools: ['get_issue']},
  },
});

beforeEach(() => {
  bridge = undefined;
  mocks.execa.mockReset().mockImplementation(async (_executable, args) => {
    if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
    bridge = args[args.indexOf('-e') + 1];
    return {stdout: finalMessage, stderr: '', failed: false, exitCode: 0};
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Pi MCP launch contract', () => {
  it.each([false, true])(
    'stops and retains a callback failure (later timeout: %s)',
    async (laterTimeout) => {
      const stdout = new PassThrough();
      let finish!: (result: object) => void;
      const child = Object.assign(
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
        {stdout},
      );
      mocks.execa.mockImplementation((_executable, args) =>
        args[0] === '--version'
          ? Promise.resolve({stdout: '0.84.2', failed: false})
          : child,
      );
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const onToolEvent = vi.fn(() => {
        if (laterTimeout) now += 10_000;
        throw new Error('Caller callback failed');
      });
      const f = options();
      const pending = runPiWithMcp({
        ...f,
        input: {...f.input, onToolEvent},
      }).catch((error: unknown) => error);
      const lines =
        [
          JSON.stringify({
            type: 'tool_execution_start',
            toolCallId: 'call-1',
            args: {id: 'DYNO-1'},
          }),
          JSON.stringify({
            type: 'tool_execution_end',
            toolCallId: 'call-1',
            toolName: 'mcp__linear__get_issue',
            isError: false,
          }),
          finalMessage,
        ].join('\n') + '\n';
      try {
        await vi.waitFor(() =>
          expect(stdout.listenerCount('data')).toBeGreaterThan(0),
        );
        stdout.write(lines);
        expect(onToolEvent).toHaveBeenCalledTimes(1);
        expect(Reflect.get(child, 'kill')).toHaveBeenCalled();
      } finally {
        finish({
          failed: laterTimeout,
          timedOut: laterTimeout,
          exitCode: laterTimeout ? undefined : 0,
          stdout: lines,
          stderr: 'debug output',
          durationMs: 1,
        });
      }
      expect(await pending).toMatchObject({
        category: 'execution_failed',
        message: expect.stringContaining('Caller callback failed'),
        output: {stdout: lines, stderr: 'debug output'},
      });
    },
  );

  it.each(['0.84.2', '0.86.0', '1.0.0'])(
    'accepts Pi %s and newer',
    async (version) => {
      mocks.execa.mockResolvedValueOnce({stdout: version, failed: false});
      const result = await runPiWithMcp(options());
      expect(result.version).toBe(version);
    },
  );

  it('rejects versions older than the tested minimum', async () => {
    mocks.execa.mockResolvedValue({stdout: '0.80.0', failed: false});
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'unsupported_version',
      message: expect.stringContaining('0.84.2 or newer'),
    });
    expect(mocks.execa).toHaveBeenCalledTimes(1);
  });

  it.each(['version', 'run'])(
    'reports a %s process timeout with raw output before the clock deadline passes',
    async (stage) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      const timeout = {
        failed: true,
        timedOut: true,
        stdout: stage === 'version' ? '0.84.2' : 'partial run output',
        stderr: 'PRIVATE_STDERR_SENTINEL',
        durationMs: 10,
      };
      if (stage === 'run')
        mocks.execa.mockResolvedValueOnce({stdout: '0.84.2', failed: false});
      mocks.execa.mockResolvedValueOnce(timeout);
      await expect(runPiWithMcp(options())).rejects.toMatchObject({
        category: 'timed_out',
        output: {
          exitCode: 1,
          stdout: timeout.stdout,
          stderr: timeout.stderr,
        },
      });
    },
  );

  it.each([
    [2, finalMessage],
    [0, 'not JSON'],
    [0, ''],
  ])(
    'retains failed run output (exit %s, stdout %j)',
    async (exitCode, stdout) => {
      mocks.execa
        .mockResolvedValueOnce({stdout: '0.84.2', failed: false})
        .mockResolvedValueOnce({
          exitCode,
          stdout,
          stderr: 'PRIVATE_STDERR_SENTINEL',
          failed: exitCode !== 0,
        });
      await expect(runPiWithMcp(options())).rejects.toMatchObject({
        category: 'execution_failed',
        output: {exitCode, stdout, stderr: 'PRIVATE_STDERR_SENTINEL'},
      });
      const args = mocks.execa.mock.calls[1]![1] as string[];
      await expect(
        access(dirname(args[args.indexOf('-e') + 1]!)),
      ).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('retains output from an unsupported version probe', async () => {
    mocks.execa.mockResolvedValueOnce({
      stdout: '0.80.0',
      stderr: 'PRIVATE_STDERR_SENTINEL',
      failed: false,
      exitCode: 0,
    });
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'unsupported_version',
      output: {
        stdout: '0.80.0',
        stderr: 'PRIVATE_STDERR_SENTINEL',
        exitCode: 0,
      },
    });
  });

  it('uses an explicit bridge, preserves the profile and unions proxy bypasses', async () => {
    const f = options();
    const result = await runPiWithMcp({...f, extraArgs: ['--thinking', 'low']});
    expect(result.harnessReady).toBe(true);
    const launch = mocks.execa.mock.calls[1]!;
    expect(launch[1]).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--no-approve',
      '--thinking',
      'low',
      '--no-extensions',
      '-e',
      bridge,
      'Say READY',
    ]);
    expect(launch[2].env).toMatchObject({
      PI_OFFLINE: '1',
      NO_PROXY: 'upper,lower,127.0.0.1,localhost,::1',
      no_proxy: 'upper,lower,127.0.0.1,localhost,::1',
    });
    expect(f.input.env).toEqual({NO_PROXY: 'upper', no_proxy: 'lower'});
    await expect(access(dirname(bridge!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports bridge readiness failures with their reason', async () => {
    mocks.execa.mockImplementation(async (_executable, args) => {
      if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
      return {
        failed: true,
        exitCode: 1,
        stdout: '',
        stderr:
          'DYNOBOX_MCP_NOT_READY: Pi did not activate MCP mock tool "mcp__linear__get_issue".\n',
      };
    });
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'not_ready',
      message: 'Pi did not activate MCP mock tool "mcp__linear__get_issue".',
    });
  });

  it('rejects Pi zero-exit model errors', async () => {
    mocks.execa.mockImplementation(async (_executable, args) => {
      if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
      return {
        failed: false,
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'model unavailable',
          },
        }),
      };
    });
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'execution_failed',
      message: 'model unavailable',
    });
  });

  it.each([
    ['--extension', 'inherited.js'],
    ['-e', 'other.js'],
    ['--extension=x'],
  ])('rejects extension arguments %j', async (...extraArgs) => {
    await expect(runPiWithMcp({...options(), extraArgs})).rejects.toMatchObject(
      {category: 'configuration_failed'},
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('keeps the portable mcp__server__tool names', () => {
    expect(
      piToolNames({
        linear: {url: 'http://127.0.0.1:1/linear', tools: ['get_issue']},
      }),
    ).toEqual(['mcp__linear__get_issue']);
  });

  it.each([0, 1])(
    'streams tool events before exit code %s',
    async (exitCode) => {
      const stdout = new PassThrough();
      let finish!: (result: object) => void;
      const child = Object.assign(
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
        {stdout},
      );
      mocks.execa.mockImplementation((_executable, args) =>
        args[0] === '--version'
          ? Promise.resolve({stdout: '0.84.2', failed: false})
          : child,
      );
      const onToolEvent = vi.fn();
      const f = options();
      const pending = runPiWithMcp({
        ...f,
        input: {...f.input, onToolEvent},
      }).then(
        (result) => ({result}),
        (error: unknown) => ({error}),
      );
      const lines =
        [
          JSON.stringify({
            type: 'tool_execution_start',
            toolCallId: 'call-1',
            args: {id: 'DYNO-1'},
          }),
          JSON.stringify({
            type: 'tool_execution_end',
            toolCallId: 'call-1',
            toolName: 'mcp__linear__get_issue',
            isError: false,
          }),
          finalMessage,
        ].join('\n') + '\n';
      try {
        await vi.waitFor(() =>
          expect(stdout.listenerCount('data')).toBeGreaterThan(0),
        );
        stdout.write(lines);
        expect(onToolEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            rawName: 'mcp__linear__get_issue',
            input: {id: 'DYNO-1'},
          }),
        );
      } finally {
        finish({exitCode, stdout: lines, stderr: '', durationMs: 1});
      }
      const outcome = await pending;
      if (exitCode === 0)
        expect(outcome).toHaveProperty('result.harnessReady', true);
      else expect(outcome).toHaveProperty('error.category', 'execution_failed');
      expect(onToolEvent).toHaveBeenCalledTimes(1);
    },
  );

  it('adds server instructions to the existing system prompt', async () => {
    const controller = await startMcpMockController({
      linear: {
        instructions: 'Use issue IDs when calling Linear.',
        tools: {
          get_issue: {inputSchema: {type: 'object'}, response: {content: []}},
        },
      },
    });
    const handlers = new Map<
      string,
      (event: {systemPrompt: string}) => unknown
    >();
    mocks.execa.mockImplementation(async (_executable, args) => {
      if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
      const extension = await import(
        pathToFileURL(args[args.indexOf('-e') + 1]).href
      );
      await extension.default({
        registerTool: vi.fn(),
        on: (
          name: string,
          handler: (event: {systemPrompt: string}) => unknown,
        ) => handlers.set(name, handler),
      });
      await handlers.get('session_shutdown')?.({systemPrompt: ''});
      return {stdout: finalMessage, stderr: '', exitCode: 0};
    });
    try {
      const f = options();
      await runPiWithMcp({
        ...f,
        servers: {linear: {url: controller.urls.linear!, tools: ['get_issue']}},
      });
      expect(
        handlers.get('before_agent_start')?.({
          systemPrompt: 'Existing instructions.',
        }),
      ).toEqual({
        systemPrompt:
          'Existing instructions.\n\nMCP server linear:\nUse issue IDs when calling Linear.',
      });
    } finally {
      await controller.finalize({harnessReady: true, harnessSucceeded: true});
    }
  });

  it('does not launch after cancellation', async () => {
    const f = options();
    await expect(
      runPiWithMcp({...f, input: {...f.input, signal: AbortSignal.abort()}}),
    ).rejects.toMatchObject({category: 'execution_failed'});
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
