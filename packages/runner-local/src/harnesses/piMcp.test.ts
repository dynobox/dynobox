import {access, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {runPiWithMcp} from './piMcp.js';

const mocks = vi.hoisted(() => ({execa: vi.fn(), rm: vi.fn()}));
vi.mock('execa', () => ({execa: mocks.execa}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {...actual, rm: mocks.rm.mockImplementation(actual.rm)};
});

const stdout = JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{type: 'text', text: 'READY'}],
    stopReason: 'stop',
  },
});
let bridge: string | undefined;
let state: unknown;
const options = () => ({
  executable: process.execPath,
  input: {
    workDir: process.cwd(),
    env: {NO_PROXY: 'upper', no_proxy: 'lower'},
    prompt: 'Say READY',
    timeoutMs: 5000,
  },
  servers: {
    linear: {url: 'http://127.0.0.1:12345/mock/token', tools: ['get_issue']},
  },
});

beforeEach(() => {
  bridge = undefined;
  state = {ready: true, closed: true};
  mocks.execa.mockReset().mockImplementation(async (_executable, args) => {
    if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
    bridge = args[args.indexOf('-e') + 1];
    if (state !== undefined)
      await writeFile(
        join(dirname(bridge!), 'status.json'),
        JSON.stringify(state),
      );
    return {stdout, stderr: '', failed: false};
  });
});
afterEach(() => vi.clearAllMocks());

describe('Pi MCP launch contract', () => {
  it.each(['0.84.2', '0.86.0'])(
    'reports tested Pi version %s',
    async (version) => {
      mocks.execa.mockResolvedValueOnce({stdout: version, failed: false});
      const result = await runPiWithMcp(options());
      expect(result.output.metadata?.mcpHarnessVersion).toBe(version);
    },
  );

  it('uses an explicit bridge, preserves the profile and unions proxy bypasses', async () => {
    const f = options();
    const result = await runPiWithMcp(f);
    expect(result.harnessReady).toBe(true);
    const launch = mocks.execa.mock.calls[1]!;
    expect(launch[1]).toEqual([
      '--mode',
      'json',
      '--no-session',
      '--no-approve',
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
    expect(launch[2].env.PI_CODING_AGENT_DIR).toBe(
      process.env.PI_CODING_AGENT_DIR,
    );
    expect(f.input.env).toEqual({NO_PROXY: 'upper', no_proxy: 'lower'});
    await expect(access(dirname(bridge!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    undefined,
    {ready: false, closed: true},
    {ready: true, closed: false},
  ])('rejects incomplete startup/shutdown evidence: %j', async (value) => {
    state = value;
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'not_ready',
    });
    await expect(access(dirname(bridge!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects Pi zero-exit model errors even after ready shutdown', async () => {
    mocks.execa.mockImplementation(async (_executable, args) => {
      if (args[0] === '--version') return {stdout: '0.84.2', failed: false};
      bridge = args[args.indexOf('-e') + 1];
      await writeFile(
        join(dirname(bridge!), 'status.json'),
        JSON.stringify({ready: true, closed: true}),
      );
      return {
        failed: false,
        stderr: '',
        stdout: JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'AUTH_SECRET',
          },
        }),
      };
    });
    await expect(runPiWithMcp(options())).rejects.toThrow(
      'Pi MCP execution_failed.',
    );
    await expect(access(dirname(bridge!))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['--extension', 'inherited.js'],
    ['--tools', 'read'],
    ['--resume'],
    ['--no-skills'],
    ['--provider', 'other'],
  ])('rejects extra arguments %j', async (...extraArgs) => {
    await expect(runPiWithMcp({...options(), extraArgs})).rejects.toMatchObject(
      {category: 'configuration_failed'},
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it.each(['@/private/file', '--extension=other', 'hello\0world'])(
    'rejects ambiguous prompts',
    async (prompt) => {
      const f = options();
      await expect(
        runPiWithMcp({...f, input: {...f.input, prompt}}),
      ).rejects.toMatchObject({category: 'configuration_failed'});
      expect(mocks.execa).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown versions before loading profile resources', async () => {
    mocks.execa.mockResolvedValue({stdout: '0.85.0', failed: false});
    await expect(runPiWithMcp(options())).rejects.toMatchObject({
      category: 'unsupported_version',
    });
    expect(mocks.execa).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe URLs, unsupported names and flattened collisions', async () => {
    for (const servers of [
      {linear: {url: 'https://example.com/mcp', tools: ['get_issue']}},
      {linear: {url: 'http://secret@127.0.0.1:1234/mcp', tools: ['get_issue']}},
      {linear: {url: 'http://127.0.0.1:1234/mcp', tools: ['get.issue']}},
      {
        a__b: {url: 'http://127.0.0.1:1234/mcp', tools: ['c']},
        a: {url: 'http://127.0.0.1:1234/mcp', tools: ['b__c']},
      },
    ])
      await expect(runPiWithMcp({...options(), servers})).rejects.toMatchObject(
        {category: 'configuration_failed'},
      );
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('does not pass after cancellation or cleanup failure', async () => {
    const f = options();
    await expect(
      runPiWithMcp({...f, input: {...f.input, signal: AbortSignal.abort()}}),
    ).rejects.toMatchObject({category: 'execution_failed'});
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    mocks.rm.mockImplementationOnce(
      async (...args: Parameters<typeof actual.rm>) => {
        await actual.rm(...args);
        throw new Error('private-secret');
      },
    );
    await expect(runPiWithMcp(f)).rejects.toThrow('Pi MCP cleanup_failed.');
  });
});
