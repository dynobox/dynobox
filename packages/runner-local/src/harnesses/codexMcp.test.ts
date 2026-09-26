import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {type CodexMcpOptions, runCodexWithMcp} from './codexMcp.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(
  mode = 'success',
  inherited: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-codex-unit-'));
  roots.push(root);
  const executable = join(root, 'codex');
  const log = join(root, 'invocations.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args = process.argv.slice(2);
const mode = process.env.DXB_TEST_MODE;
appendFileSync(process.env.DXB_TEST_LOG, JSON.stringify({args, cwd: process.cwd(), noProxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY, marker: process.env.DXB_ENV_MARKER}) + '\\n');
if (args.includes('--version')) {console.log(mode === 'version' ? 'codex-cli 0.100.0' : mode === 'newer' ? 'codex-cli 0.999.0' : 'codex-cli 0.153.4'); process.exit(0);}
const config = {features: {apps: false, remote_plugin: false, skill_mcp_dependency_install: false}, mcp_servers: JSON.parse(process.env.DXB_TEST_INHERITED), plugins: {}};
for (const arg of args) {
  if (arg.startsWith('mcp_servers=')) {
    const overlay = JSON.parse(arg.slice(12).replace(/("(?:[^"\\\\]|\\\\.)*")=/g, '$1:'));
    for (const [name, entry] of Object.entries(overlay)) config.mcp_servers[name] = {...config.mcp_servers[name], ...entry};
  }
}
const enabled = Object.entries(config.mcp_servers).filter(([, entry]) => entry.enabled !== false);
if (mode === 'feature') config.features.apps = true;
if (args.includes('app-server')) {
  if (mode === 'probe-hang') setInterval(() => {}, 1000);
  else createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    let result = {};
    if (request.method === 'config/read') result = {config};
    if (request.method === 'plugin/list') result = {marketplaces: [], marketplaceLoadErrors: []};
    console.log(JSON.stringify({id: request.id, result}));
  });
} else if (mode === 'hang') {setInterval(() => {}, 1000);}
else {
  console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture'}));
  console.log(JSON.stringify({type: 'turn.started'}));
  if (mode === 'bad-json') console.log('PRIVATE_SENTINEL');
  if (mode === 'failed-turn') console.log(JSON.stringify({type: 'turn.failed', error: {message: 'PRIVATE_SENTINEL'}}));
  if (mode === 'tool') console.log(JSON.stringify({type: 'item.completed', item: {type: 'mcp_tool_call', server: enabled[0][0], tool: 'lookup', arguments: {key: 'receipt'}, status: 'completed'}}));
  console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: 'OK'}}));
  if (mode !== 'no-completion') console.log(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}));
  if (mode === 'exit') process.exitCode = 1;
}
`,
  );
  await chmod(executable, 0o700);
  const options: CodexMcpOptions = {
    executable,
    input: {
      prompt: 'Reply OK.',
      workDir: root,
      timeoutMs: 5000,
      env: {
        DXB_TEST_MODE: mode,
        DXB_TEST_LOG: log,
        DXB_TEST_INHERITED: JSON.stringify(inherited),
      },
    },
    servers: {
      service: {
        url: 'http://127.0.0.1:12345/service',
        tools: ['lookup'],
      },
    },
  };
  const invocations = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            cwd: string;
            noProxy: string;
            NO_PROXY: string;
            marker: string;
          },
      );
  return {options, invocations};
}

describe('Codex MCP adapter', () => {
  it('preserves logical names without collisions and normal environment and permissions', async () => {
    const f = await fixture();
    f.options.input.env.NO_PROXY = 'one.example';
    f.options.input.env.no_proxy = 'two.example';
    f.options.input.env.DXB_ENV_MARKER = 'preserved';
    const run = await runCodexWithMcp(f.options);
    expect(run.harnessReady).toBe(true);
    expect(run.output.metadata).toEqual({
      mcpHarnessVersion: '0.153.4',
      mcpRunToolEvents: [],
    });
    const calls = await f.invocations();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.marker).toBe('preserved');
      expect(call.noProxy).toBe(call.NO_PROXY);
      expect(call.noProxy.split(',')).toEqual(
        expect.arrayContaining([
          'one.example',
          'two.example',
          '127.0.0.1',
          'localhost',
          '::1',
        ]),
      );
      expect(call.args).not.toContain('--ignore-user-config');
      expect(call.args).not.toContain('--ignore-rules');
      expect(call.args).not.toContain('sandbox_mode="danger-full-access"');
    }
    expect(calls[2]!.args).toContainEqual(
      expect.stringContaining('"service"={"url"='),
    );
    expect(calls[2]!.args.slice(-2)).toEqual(['--', 'Reply OK.']);
  });

  it('accepts newer Codex releases', async () => {
    const f = await fixture('newer');
    const run = await runCodexWithMcp(f.options);
    expect(run.output.metadata?.mcpHarnessVersion).toBe('0.999.0');
  });

  it('aliases name collisions without copying the inherited transport and preserves MCP policy', async () => {
    const f = await fixture('tool', {
      service: {
        command: '/original',
        args: ['PRIVATE_SENTINEL'],
        env: {KEY: 'PRIVATE_SENTINEL'},
        enabled: true,
        default_tools_approval_mode: 'prompt',
        tools: {lookup: {approval_mode: 'approve'}},
      },
    });
    const events: unknown[] = [];
    f.options.input.onToolEvent = (event) => events.push(event);
    const run = await runCodexWithMcp(f.options);
    expect(run.output.metadata?.mcpRunToolEvents).toEqual(events);
    const calls = await f.invocations();
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_SENTINEL');
    const overlay = calls
      .at(-1)!
      .args.find((arg) => arg.startsWith('mcp_servers='))!;
    expect(overlay).toContain('"dynobox_service_1"');
    expect(overlay).toContain('"default_tools_approval_mode"="prompt"');
    expect(overlay).toContain('"approval_mode"="approve"');
    expect(JSON.stringify(events)).toContain('mcp__service__lookup');
    expect(JSON.stringify(events)).not.toContain('dynobox_');
  });

  it.each([
    ['--profile', 'other'],
    ['-pother'],
    ['-c', 'mcp_servers={}'],
    ['--config=mcp_servers={}'],
    ['--ignore-user-config'],
    ['--enable', 'apps'],
    ['--disable', 'plugins'],
  ])(
    'rejects config-changing extra arguments %j before any process starts',
    async (...args) => {
      const f = await fixture();
      f.options.extraArgs = args;
      await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
        category: 'configuration_failed',
      });
      await expect(f.invocations()).rejects.toThrow();
    },
  );

  it.each([
    ['version', 'unsupported_version', /0\.153\.4 or newer/],
    ['feature', 'configuration_failed', /feature "apps" is forced on/],
    ['no-completion', 'execution_failed', /without completing/],
    ['failed-turn', 'execution_failed', /turn\.failed/],
    ['bad-json', 'execution_failed', /unparseable/],
    ['exit', 'execution_failed', /exited with code 1/],
  ])(
    'reports %s as %s with a readable reason',
    async (mode, category, message) => {
      const f = await fixture(mode);
      await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
        category,
        message: expect.stringMatching(message),
      });
      if (mode === 'version' || mode === 'feature')
        expect(
          (await f.invocations()).some((call) => call.args[0] === 'exec'),
        ).toBe(false);
    },
  );

  it.each([
    {enabled: false},
    {disabled_tools: ['lookup']},
    {enabled_tools: ['other']},
  ])('preserves inherited exclusions %j', async (policy) => {
    const f = await fixture('success', {
      service: {command: '/original', ...policy},
    });
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    expect(await f.invocations()).toHaveLength(2);
  });

  it('uses explicit dangerous mode and CLI mock settings consistently during preflight and execution', async () => {
    const f = await fixture();
    f.options.input.permissionMode = 'dangerous';
    f.options.input.model = 'gpt-5.4';
    f.options.input.cliMocksEnabled = true;
    f.options.input.env.DYNOBOX_CLI_MOCK_BIN = '/fixture/bin';
    await runCodexWithMcp(f.options);
    for (const call of (await f.invocations()).slice(1)) {
      expect(call.args).toContain('sandbox_mode="danger-full-access"');
      expect(call.args).toContain('approval_policy="never"');
      expect(call.args).toContain('model="gpt-5.4"');
      expect(call.args).toContain(
        'shell_environment_policy.set.DYNOBOX_CLI_MOCK_BIN="/fixture/bin"',
      );
    }
  });

  it('grants only an explicitly requested declared MCP tool', async () => {
    const f = await fixture();
    f.options.input.allowedMcpTools = [{server: 'service', tool: 'lookup'}];
    await runCodexWithMcp(f.options);
    expect((await f.invocations()).at(-1)!.args.join(' ')).toContain(
      '"lookup"={"approval_mode"="approve"}',
    );
  });

  it.each(['probe-hang', 'hang'])(
    'bounds and cancels %s processes',
    async (mode) => {
      const f = await fixture(mode);
      const abort = new AbortController();
      f.options.input.signal = abort.signal;
      const pending = runCodexWithMcp(f.options).catch((error) => error);
      await vi.waitFor(async () =>
        expect((await f.invocations()).length).toBeGreaterThanOrEqual(
          mode === 'probe-hang' ? 2 : 3,
        ),
      );
      abort.abort();
      expect(await pending).toMatchObject({category: 'execution_failed'});
    },
  );

  it('bounds preflight by the invocation deadline', async () => {
    const f = await fixture('probe-hang');
    f.options.input.timeoutMs = 250;
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'timed_out',
    });
  });
});
