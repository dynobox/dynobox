import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {
  ClaudeCodeMcpError,
  type ClaudeCodeMcpOptions,
  runClaudeCodeWithMcp,
} from './claudeCodeMcp.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: vi.fn((await importOriginal<typeof import('node:fs/promises')>()).rm),
}));

const roots: string[] = [];
const controllers: Awaited<ReturnType<typeof startMcpMockController>>[] = [];

const definitions = (text = 'fixture') => ({
  service: {
    tools: {
      lookup: {
        inputSchema: {type: 'object'},
        response: {content: [{type: 'text', text}]},
      },
    },
  },
});

async function fixture(mode = 'negative', text = 'fixture') {
  const root = await fs.mkdtemp(join(tmpdir(), 'dynobox-claude-mcp-test-'));
  roots.push(root);
  const controller = await startMcpMockController(definitions(text));
  controllers.push(controller);
  const executable = join(root, 'claude');
  await fs.writeFile(executable, FAKE_CLAUDE, {mode: 0o755});
  const options: ClaudeCodeMcpOptions = {
    executable,
    input: {
      prompt: 'Perform the task.',
      workDir: root,
      env: {PROBE_LOG: join(root, 'launches.jsonl'), PROBE_MODE: mode},
      timeoutMs: 5000,
    },
    servers: {service: {url: controller.urls.service!, tools: ['lookup']}},
  };
  const launches = async () => {
    const lines = await fs.readFile(options.input.env.PROBE_LOG!, 'utf8');
    return lines
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  };
  return {root, controller, options, launches};
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    controllers.splice(0).map((controller) =>
      controller.finalize({
        harnessReady: false,
        harnessSucceeded: false,
      }),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})),
  );
});

describe('isolated Claude Code MCP invocation', () => {
  it('preserves environment, settings, permissions and literal prompt arguments', async () => {
    const {options, launches, controller, root} = await fixture();
    const original = JSON.stringify({
      mcpServers: {inherited: {command: 'never-run'}},
    });
    await fs.writeFile(join(root, '.mcp.json'), original);
    const settings = JSON.stringify({permissions: {defaultMode: 'plan'}});
    await fs.mkdir(join(root, '.claude'));
    await fs.writeFile(join(root, '.claude', 'settings.json'), settings);
    options.input.env = {
      ...options.input.env,
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      ANTHROPIC_API_KEY: 'auth-sentinel',
      NO_PROXY: 'upper.example',
      no_proxy: 'lower.example,upper.example',
      PATH: '/not-a-real-executable-search-path',
    };
    options.input.prompt = '--mcp-config attacker.json $(touch never)';
    options.extraArgs = [
      '--allowedTools',
      'Read,mcp__service__lookup',
      '--effort=low',
    ];
    const result = await runClaudeCodeWithMcp(options);
    const [probe, launch] = await launches();
    expect(result.harnessReady).toBe(true);
    expect(probe.config).toEqual(launch.config);
    expect(launch.config).toEqual({
      mcpServers: {service: {type: 'http', url: controller.urls.service}},
    });
    expect(probe.cwd).toBe(await fs.realpath(root));
    expect(probe.env).toEqual(launch.env);
    expect(launch.env).toMatchObject({
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      ANTHROPIC_API_KEY: 'auth-sentinel',
      NO_PROXY: 'upper.example,lower.example,127.0.0.1,localhost,::1',
      no_proxy: 'upper.example,lower.example,127.0.0.1,localhost,::1',
    });
    expect(launch.args.slice(-2)).toEqual(['--', options.input.prompt]);
    expect(launch.args).toContain('--allowedTools=Read,mcp__service__lookup');
    expect(launch.args).not.toContain('--permission-mode');
    expect(launch.args).not.toContain('--setting-sources');
    expect(launch.args).not.toContain('--disable-slash-commands');
    expect(launch.args).not.toContain('--bare');
    expect(launch.mode).toBe(0o600);
    expect(launch.directoryMode).toBe(0o700);
    await expect(fs.stat(dirname(launch.path))).rejects.toThrow();
    expect(await fs.readFile(join(root, '.mcp.json'), 'utf8')).toBe(original);
    expect(
      await fs.readFile(join(root, '.claude', 'settings.json'), 'utf8'),
    ).toBe(settings);
    expect(
      await controller.finalize({harnessReady: true, harnessSucceeded: true}),
    ).toMatchObject({ready: true, calls: [], failures: []});
  });

  it('adds bypass permissions only when explicitly requested', async () => {
    const {options, launches} = await fixture();
    options.input.permissionMode = 'dangerous';
    await runClaudeCodeWithMcp(options);
    expect((await launches())[1].args).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    );
  });

  it.each([
    ['--mcp-config', 'other.json'],
    ['--strict-mcp-config=false'],
    ['--settings={}'],
    ['--setting-sources', 'user'],
    ['--plugin-dir', '/tmp/plugin'],
    ['--resume', 'session'],
    ['--continue'],
    ['--attach', 'session'],
    ['--add-dir', '/tmp'],
    ['--worktree'],
    ['--cloud'],
    ['--ide'],
    ['--chrome'],
    ['--output-format=json'],
    ['--input-format=stream-json'],
    ['--agents={}'],
    ['--bare'],
    ['--restricted'],
    ['--disable-slash-commands'],
    ['--'],
    ['extra-prompt'],
    ['--effort'],
    ['--effort', '--mcp-config'],
    ['--effort=other'],
    ['--max-budget-usd=Infinity'],
    ['--max-budget-usd=-1'],
    ['--permission-mode=unknown'],
    ['--append-system-prompt=bad\0value'],
    ['--effort=low', '--effort=high'],
  ])('rejects unsafe or ambiguous arguments: %j', async (...args) => {
    const {options, launches} = await fixture();
    options.extraArgs = args;
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(launches()).rejects.toThrow();
  });

  it.each(['claude', './claude'])(
    'rejects unresolved executable %s',
    async (executable) => {
      const {options} = await fixture();
      options.executable = executable;
      await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
        category: 'configuration_failed',
      });
    },
  );

  it('rejects external URLs and ambiguous flattened tool names before launch', async () => {
    const {options, launches} = await fixture();
    options.servers = {
      service: {url: 'https://real.example/mcp', tools: ['lookup']},
    };
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    const url = `http://127.0.0.1:1234/${'a'.repeat(48)}`;
    options.servers = {a: {url, tools: ['b__c']}, a__b: {url, tools: ['c']}};
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(launches()).rejects.toThrow();
  });

  it.each([
    'failed',
    'denied',
    'missing-server',
    'extra-server',
    'duplicate-server',
    'missing-tool',
    'extra-tool',
    'config-error',
    'no-init',
    'duplicate-init',
  ])('fails readiness and cleans config for %s', async (mode) => {
    const {options, launches, controller} = await fixture(mode);
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    const launch = (await launches())[1];
    await expect(fs.stat(dirname(launch.path))).rejects.toThrow();
    const observation = await controller.finalize({
      harnessReady: false,
      harnessSucceeded: false,
    });
    expect(observation.ready).toBe(false);
    expect(observation.failures).toContain('not_ready');
  });

  it('cannot use startup listings as controller discovery evidence', async () => {
    const {options, controller} = await fixture('no-discovery');
    const result = await runClaudeCodeWithMcp(options);
    const observation = await controller.finalize({
      harnessReady: result.harnessReady,
      harnessSucceeded: true,
    });
    expect(observation.ready).toBe(false);
    expect(observation.failures).toContain('not_ready');
  });

  it('fails a disconnected controller even for a negative-only run', async () => {
    const {options, controller, launches} = await fixture();
    await controller.finalize({harnessReady: false, harnessSucceeded: false});
    await expect(runClaudeCodeWithMcp(options)).rejects.toBeInstanceOf(
      ClaudeCodeMcpError,
    );
    await expect(
      fs.stat(dirname((await launches())[1].path)),
    ).rejects.toThrow();
  });

  it('keeps concurrent configs, discovery, calls and responses invocation-local', async () => {
    const first = await fixture('call', 'first');
    const second = await fixture('call', 'second');
    // Same executable, as with concurrent calls on the same harness instance.
    second.options.executable = first.options.executable;
    const results = await Promise.all([
      runClaudeCodeWithMcp(first.options),
      runClaudeCodeWithMcp(second.options),
    ]);
    const paths = [
      (await first.launches())[1].path,
      (await second.launches())[1].path,
    ];
    expect(paths[0]).not.toBe(paths[1]);
    for (const [index, entry] of [first, second].entries()) {
      expect(results[index]!.output.stdout).toContain(
        index === 0 ? 'first' : 'second',
      );
      const observation = await entry.controller.finalize({
        harnessReady: true,
        harnessSucceeded: true,
      });
      expect(observation).toMatchObject({
        ready: true,
        failures: [],
        calls: [
          {
            sequence: 1,
            server: 'service',
            tool: 'lookup',
            input: {literal: 'value'},
            category: 'success',
          },
        ],
      });
      await expect(fs.stat(dirname(paths[index]))).rejects.toThrow();
      await expect(fetch(entry.controller.urls.service!)).rejects.toThrow();
    }
  });

  it.each([
    'unsupported',
    'exit',
    'result-error',
    'malformed',
    'hang',
    'hang-version',
  ])('cleans config on %s without leaking diagnostics', async (mode) => {
    const {options, launches} = await fixture(mode);
    options.input.timeoutMs = 500;
    let error: unknown;
    try {
      await runClaudeCodeWithMcp(options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ClaudeCodeMcpError);
    expect(String(error)).not.toContain('SECRET');
    expect(String(error)).not.toContain(options.servers.service!.url);
    expect((error as Error).cause).toBeUndefined();
    await expect(
      fs.stat(dirname((await launches())[0].path)),
    ).rejects.toThrow();
  });

  it('cleans up on cancellation and does not launch when already cancelled', async () => {
    const {options, launches} = await fixture('hang');
    const abort = new AbortController();
    options.signal = abort.signal;
    const pending = runClaudeCodeWithMcp(options);
    const rejected = expect(pending).rejects.toMatchObject({
      category: 'execution_failed',
    });
    await vi.waitFor(async () => expect((await launches()).length).toBe(2));
    abort.abort();
    await rejected;
    await expect(
      fs.stat(dirname((await launches())[1].path)),
    ).rejects.toThrow();
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
    });
    expect((await launches()).length).toBe(2);
  });

  it('fails the invocation when config cleanup fails', async () => {
    const {options, launches} = await fixture();
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('SECRET cleanup path'));
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'cleanup_failed',
    });
    vi.restoreAllMocks();
    // The injected cleanup failure leaves an owned directory for the test to remove.
    roots.push(dirname((await launches())[0].path));
  });

  it('bounds stalled cleanup and retains the original safe failure category', async () => {
    const {options, launches} = await fixture('exit');
    vi.mocked(fs.rm).mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'cleanup_failed',
      priorCategory: 'execution_failed',
    });
    expect(Date.now() - started).toBeLessThan(3000);
    roots.push(dirname((await launches())[0].path));
  });

  it('snapshots input before the version probe yields', async () => {
    const {options, launches} = await fixture('slow-version');
    const pending = runClaudeCodeWithMcp(options);
    await vi.waitFor(async () => expect((await launches()).length).toBe(1));
    options.input.prompt = '--resume changed';
    options.input.model = 'changed-model';
    options.input.env.ANTHROPIC_API_KEY = 'changed-key';
    await pending;
    const [probe, launch] = await launches();
    expect(launch.args.at(-1)).toBe('Perform the task.');
    expect(launch.args).not.toContain('changed-model');
    expect(launch.env).toEqual(probe.env);
  });
});

// A child-process test double, not evidence that native Claude excludes sources.
// It uses actual HTTP initialization/discovery/calls against our controller.
const FAKE_CLAUDE = `#!${process.execPath}
import {appendFileSync, readFileSync, statSync} from 'node:fs';
import {dirname} from 'node:path';
const args = process.argv.slice(2);
const path = args[args.indexOf('--mcp-config') + 1];
const config = JSON.parse(readFileSync(path, 'utf8'));
const mode = process.env.PROBE_MODE;
appendFileSync(process.env.PROBE_LOG, JSON.stringify({args, path, config, cwd: process.cwd(),
  env: Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'NO_PROXY', 'no_proxy', 'PATH'].map(k => [k, process.env[k]])),
  mode: statSync(path).mode & 0o777, directoryMode: statSync(dirname(path)).mode & 0o777}) + '\\n');
if (args.includes('--version')) {
  if (mode === 'slow-version') await new Promise(resolve => setTimeout(resolve, 200));
  if (mode === 'hang-version') await new Promise(() => setInterval(() => {}, 1000));
  console.log(mode === 'unsupported' ? '9.0.0 (Claude Code)' : '2.1.263 (Claude Code)');
  process.exit(0);
}
if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));
if (mode === 'exit') { console.error('SECRET stderr ' + path); process.exit(1); }
if (mode === 'malformed') { console.log('SECRET invalid JSON'); process.exit(0); }
const url = config.mcpServers.service.url;
let id = 0;
async function rpc(method, params) {
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  return (await response.json()).result;
}
if (mode !== 'no-discovery') {
  await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'claude-test-double', version: '1'}});
  await rpc('tools/list', {});
}
const init = {type: 'system', subtype: 'init', mcp_servers: [{name: 'service', status: 'connected'}], tools: ['Read', 'mcp__service__lookup']};
if (mode === 'failed' || mode === 'denied') init.mcp_servers[0].status = mode;
if (mode === 'missing-server') init.mcp_servers = [];
if (mode === 'extra-server') init.mcp_servers.push({name: 'inherited', status: 'connected'});
if (mode === 'duplicate-server') init.mcp_servers.push(init.mcp_servers[0]);
if (mode === 'missing-tool') init.tools = ['Read'];
if (mode === 'extra-tool') init.tools.push('mcp__inherited__tool');
if (mode === 'config-error') init.mcp_server_errors = [{name: 'service', error: 'SECRET'}];
if (mode !== 'no-init') console.log(JSON.stringify(init));
if (mode === 'duplicate-init') console.log(JSON.stringify(init));
let result = 'No tools called.';
if (mode === 'call') result = JSON.stringify(await rpc('tools/call', {name: 'lookup', arguments: {literal: 'value'}}));
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: mode === 'result-error', result}));
`;
