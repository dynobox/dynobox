import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {CodexHarness} from './codex.js';
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
if (args.includes('--version')) {console.log(mode === 'version' ? 'codex-cli 0.999.0' : 'codex-cli 0.153.4'); process.exit(0);}
const config = {features: {apps: false, remote_plugin: false, skill_mcp_dependency_install: false}, mcp_servers: JSON.parse(process.env.DXB_TEST_INHERITED), plugins: {}};
for (const arg of args) {
  if (arg.startsWith('mcp_servers=')) {
    const overlay = JSON.parse(arg.slice(12).replace(/("(?:[^"\\\\]|\\\\.)*")=/g, '$1:'));
    for (const [name, entry] of Object.entries(overlay)) config.mcp_servers[name] = {...config.mcp_servers[name], ...entry};
  }
}
const enabled = Object.entries(config.mcp_servers).filter(([, entry]) => entry.enabled !== false);
const overlaid = args.some(arg => arg.startsWith('mcp_servers='));
if (overlaid && mode === 'managed') config.mcp_servers.unexpected = {url: 'https://secret.invalid/PRIVATE', enabled: true};
if (overlaid && mode === 'credential') enabled[0][1].http_headers = {Authorization: 'PRIVATE_SENTINEL'};
if (overlaid && mode === 'required') enabled[0][1].required = false;
if (overlaid && mode === 'feature') config.features.apps = true;
if (args.includes('app-server')) {
  if (mode === 'probe-hang') setInterval(() => {}, 1000);
  else createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (mode === 'malformed') {console.log('PRIVATE_SENTINEL invalid JSON'); return;}
    let result = {};
    if (request.method === 'configRequirements/read') result = {requirements: mode === 'managed-feature' ? {featureRequirements: {apps: true}} : null};
    if (request.method === 'config/read') result = {config};
    if (request.method === 'plugin/list') result = {marketplaces: [], marketplaceLoadErrors: mode === 'catalog' ? [{}] : []};
    console.log(JSON.stringify({id: request.id, result}));
  });
} else if (args.includes('list')) {
  console.log(JSON.stringify(Object.entries(config.mcp_servers).map(([name, entry]) => ({name, enabled: entry.enabled !== false && mode !== 'disabled', disabled_reason: null, transport: {type: 'streamable_http', url: entry.url, bearer_token_env_var: null, http_headers: null, env_http_headers: null, http_headers_helper: null}}))));
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
        url: `http://127.0.0.1:12345/${'a'.repeat(48)}`,
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
    expect(calls).toHaveLength(5);
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
    expect(calls[4]!.args).toContainEqual(
      expect.stringContaining('"service"={"url"='),
    );
    expect(calls[4]!.args.slice(-2)).toEqual(['--', 'Reply OK.']);
  });

  it('aliases transport collisions without copying credentials and preserves MCP policy', async () => {
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
    expect(new CodexHarness().extractResult(run.output).toolEvents).toEqual(
      events,
    );
    const calls = await f.invocations();
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_SENTINEL');
    const overlay = calls
      .at(-1)!
      .args.find((arg) => arg.startsWith('mcp_servers='))!;
    expect(overlay).toContain('"dxb_');
    expect(overlay).toContain('"default_tools_approval_mode"="prompt"');
    expect(overlay).toContain('"approval_mode"="approve"');
    expect(JSON.stringify(events)).toContain('mcp__service__lookup');
    expect(JSON.stringify(events)).not.toContain('dxb_');
  });

  it.each([
    ['--cd', '/tmp'],
    ['-C/tmp'],
    ['resume'],
    ['--profile', 'other'],
    ['-pother'],
    ['-c', 'mcp_servers={}'],
    ['--config=mcp_servers={}'],
    ['--ignore-user-config'],
    ['--enable', 'apps'],
    ['--disable', 'plugins'],
    ['--output-last-message', '/tmp/result'],
    ['--', 'escape'],
    ['--ephemeral', '--ephemeral'],
  ])(
    'rejects unsafe extra arguments %j before any process starts',
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
    'version',
    'malformed',
    'catalog',
    'managed',
    'managed-feature',
    'credential',
    'required',
    'feature',
    'disabled',
    'no-completion',
    'failed-turn',
    'bad-json',
    'exit',
  ])('fails closed for %s without exposing raw diagnostics', async (mode) => {
    const f = await fixture(mode);
    const error = await runCodexWithMcp(f.options).catch(
      (error) => error as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('PRIVATE_SENTINEL');
    expect(String(error)).not.toContain('secret.invalid');
    if (
      [
        'version',
        'malformed',
        'catalog',
        'managed',
        'managed-feature',
        'credential',
        'required',
        'feature',
        'disabled',
      ].includes(mode)
    )
      expect(
        (await f.invocations()).some((call) => call.args[0] === 'exec'),
      ).toBe(false);
  });

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
    f.options.input.allowedMcpTools = [{server: 'other', tool: 'lookup'}];
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
  });

  it.each(['probe-hang', 'hang'])(
    'bounds and cancels %s processes',
    async (mode) => {
      const f = await fixture(mode);
      const abort = new AbortController();
      f.options.signal = abort.signal;
      const pending = runCodexWithMcp(f.options).catch((error) => error);
      await vi.waitFor(async () =>
        expect((await f.invocations()).length).toBeGreaterThanOrEqual(
          mode === 'probe-hang' ? 2 : 5,
        ),
      );
      abort.abort();
      expect(await pending).toMatchObject({category: 'execution_failed'});
    },
  );

  it('bounds preflight by the invocation deadline', async () => {
    const f = await fixture('probe-hang');
    f.options.input.timeoutMs = 250;
    await expect(runCodexWithMcp(f.options)).rejects.toBeInstanceOf(Error);
  });

  it('keeps concurrent colliding configurations independent', async () => {
    const first = await fixture('success', {service: {command: '/original'}});
    const second = await fixture('success', {service: {command: '/original'}});
    await Promise.all([
      runCodexWithMcp(first.options),
      runCodexWithMcp(second.options),
    ]);
    const firstArgs = (await first.invocations()).at(-1)!.args;
    const secondArgs = (await second.invocations()).at(-1)!.args;
    expect(firstArgs.find((arg) => arg.startsWith('mcp_servers='))).not.toBe(
      secondArgs.find((arg) => arg.startsWith('mcp_servers=')),
    );
  });
});
