import {access} from 'node:fs/promises';
import {dirname} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {piToolAliases, runPiWithMcp} from './piMcp.js';

const mocks = vi.hoisted(() => ({execa: vi.fn()}));
vi.mock('execa', () => ({execa: mocks.execa}));

const toolStart = (name: string) =>
  JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: name,
    args: {id: 'A-1'},
  });
const toolEnd = (name: string) =>
  JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: name,
    result: {content: []},
    isError: false,
  });
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
    return {stdout: finalMessage, stderr: '', failed: false};
  });
});
afterEach(() => vi.clearAllMocks());

describe('Pi MCP launch contract', () => {
  it.each(['0.84.2', '0.86.0', '1.0.0'])(
    'accepts Pi %s and newer',
    async (version) => {
      mocks.execa.mockResolvedValueOnce({stdout: version, failed: false});
      const result = await runPiWithMcp(options());
      expect(result.output.metadata?.mcpHarnessVersion).toBe(version);
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

  it('registers Pi-incompatible names under aliases and reports logical names', async () => {
    const servers = {
      'linear.v2': {url: 'http://127.0.0.1:1/linear.v2', tools: ['get.issue']},
      long: {url: 'http://127.0.0.1:1/long', tools: ['t'.repeat(80)]},
    };
    const aliases = piToolAliases(servers);
    const dotted = aliases['mcp__linear.v2__get.issue']!;
    expect(dotted).toMatch(/^mcp__[a-f0-9]{24}$/);
    expect(aliases[`mcp__long__${'t'.repeat(80)}`]).toMatch(
      /^[a-zA-Z0-9_-]{1,64}$/,
    );
    mocks.execa.mockImplementation(async (_executable, args) => {
      if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
      return {
        failed: false,
        stderr: '',
        stdout: [toolStart(dotted), toolEnd(dotted), finalMessage].join('\n'),
      };
    });
    const events: unknown[] = [];
    const result = await runPiWithMcp({
      ...options(),
      servers,
      input: {...options().input, onToolEvent: (event) => events.push(event)},
    });
    expect(events).toEqual([
      expect.objectContaining({rawName: 'mcp__linear.v2__get.issue'}),
    ]);
    expect(result.output.metadata?.mcpRunToolEvents).toEqual(events);
  });

  it('keeps compatible names unchanged', () => {
    expect(
      piToolAliases({
        linear: {url: 'http://127.0.0.1:1/linear', tools: ['get_issue']},
      }),
    ).toEqual({mcp__linear__get_issue: 'mcp__linear__get_issue'});
  });

  it('does not launch after cancellation', async () => {
    const f = options();
    await expect(
      runPiWithMcp({...f, input: {...f.input, signal: AbortSignal.abort()}}),
    ).rejects.toMatchObject({category: 'execution_failed'});
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
