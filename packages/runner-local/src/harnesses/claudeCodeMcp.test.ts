import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {
  type ClaudeCodeMcpOptions,
  runClaudeCodeWithMcp,
} from './claudeCodeMcp.js';
import {McpHarnessError} from './mcpError.js';

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
  it('preserves environment, settings and literal prompt arguments', async () => {
    const {options, launches, controller, root} = await fixture();
    const original = JSON.stringify({
      mcpServers: {inherited: {command: 'never-run'}},
    });
    await fs.writeFile(join(root, '.mcp.json'), original);
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
    options.extraArgs = ['--effort=low'];
    const result = await runClaudeCodeWithMcp(options);
    const [launch] = await launches();
    expect(result.harnessReady).toBe(true);
    expect(result.output.metadata?.mcpHarnessVersion).toBe('2.1.263');
    expect(launch.config).toEqual({
      mcpServers: {service: {type: 'http', url: controller.urls.service}},
    });
    expect(launch.cwd).toBe(await fs.realpath(root));
    expect(launch.env).toMatchObject({
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, '.claude'),
      ANTHROPIC_API_KEY: 'auth-sentinel',
      NO_PROXY: 'upper.example,lower.example,127.0.0.1,localhost,::1',
      no_proxy: 'upper.example,lower.example,127.0.0.1,localhost,::1',
    });
    expect(launch.args.slice(-2)).toEqual(['--', options.input.prompt]);
    expect(launch.args).toEqual(
      expect.arrayContaining(['--effort=low', '--strict-mcp-config']),
    );
    expect(launch.args).not.toContain('--permission-mode');
    await expect(fs.stat(dirname(launch.path))).rejects.toThrow();
    expect(await fs.readFile(join(root, '.mcp.json'), 'utf8')).toBe(original);
    expect(
      await controller.finalize({harnessReady: true, harnessSucceeded: true}),
    ).toMatchObject({ready: true, calls: [], failures: []});
  });

  it('accepts newer Claude Code releases', async () => {
    const {options} = await fixture('newer');
    const result = await runClaudeCodeWithMcp(options);
    expect(result.output.metadata?.mcpHarnessVersion).toBe('2.1.283');
  });

  it('adds bypass permissions only when explicitly requested', async () => {
    const {options, launches} = await fixture();
    options.input.permissionMode = 'dangerous';
    await runClaudeCodeWithMcp(options);
    expect((await launches())[0].args).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    );
  });

  it.each([
    [[], '--allowedTools=mcp__service__lookup'],
    [
      ['--allowedTools', 'Read,Bash'],
      '--allowedTools=Read,Bash,mcp__service__lookup',
    ],
    [['--allowed-tools=Read'], '--allowed-tools=Read,mcp__service__lookup'],
  ])(
    'merges MCP tool grants into existing allow lists: %j',
    async (extraArgs, expected) => {
      const {options, launches} = await fixture();
      options.extraArgs = extraArgs;
      options.input.allowedMcpTools = [{server: 'service', tool: 'lookup'}];
      await runClaudeCodeWithMcp(options);
      const args: string[] = (await launches())[0].args;
      expect(args).toContain(expected);
      expect(
        args.filter((arg) => /^--allowed-?[tT]ools/.test(arg)),
      ).toHaveLength(1);
    },
  );

  it.each([
    [['--mcp-config', 'other.json']],
    [['--strict-mcp-config']],
    [['--allowedTools', 'Read', '--allowed-tools', 'Bash']],
  ])('rejects conflicting extra arguments: %j', async (extraArgs) => {
    const {options, launches} = await fixture();
    options.extraArgs = extraArgs;
    options.input.allowedMcpTools = [{server: 'service', tool: 'lookup'}];
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(launches()).rejects.toThrow();
  });

  it.each([
    'failed',
    'denied',
    'missing-server',
    'missing-tool',
    'no-init',
    'extra-server',
  ])('fails readiness and cleans config for %s', async (mode) => {
    const {options, launches, controller} = await fixture(mode);
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    await expect(
      fs.stat(dirname((await launches())[0].path)),
    ).rejects.toThrow();
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
    const {options, controller} = await fixture();
    await controller.finalize({harnessReady: false, harnessSucceeded: false});
    await expect(runClaudeCodeWithMcp(options)).rejects.toBeInstanceOf(
      McpHarnessError,
    );
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
      (await first.launches())[0].path,
      (await second.launches())[0].path,
    ];
    expect(paths[0]).not.toBe(paths[1]);
    for (const [index, entry] of [first, second].entries()) {
      expect(results[index]!.output.stdout).toContain(
        index === 0 ? 'first' : 'second',
      );
      expect(
        await entry.controller.finalize({
          harnessReady: true,
          harnessSucceeded: true,
        }),
      ).toMatchObject({
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
    }
  });

  it.each([
    ['unsupported', 'unsupported_version', /requires 2\.1\.263 or newer/],
    ['exit', 'execution_failed', /exited with code 1/],
    ['result-error', 'execution_failed', /unsuccessful result/],
    ['malformed', 'execution_failed', /unparseable/],
    ['hang', 'timed_out', /timeout/],
  ])(
    'reports %s as %s with a readable reason',
    async (mode, category, message) => {
      const {options} = await fixture(mode);
      if (mode === 'hang') options.input.timeoutMs = 500;
      const error = await runClaudeCodeWithMcp(options).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(McpHarnessError);
      expect(error).toMatchObject({
        category,
        message: expect.stringMatching(message),
      });
    },
  );

  it('stops on cancellation and does not launch when already cancelled', async () => {
    const {options, launches} = await fixture('hang');
    const abort = new AbortController();
    options.input.signal = abort.signal;
    const pending = runClaudeCodeWithMcp(options);
    const rejected = expect(pending).rejects.toMatchObject({
      category: 'execution_failed',
    });
    await vi.waitFor(async () => expect((await launches()).length).toBe(1), {
      timeout: 10_000,
    });
    abort.abort();
    await rejected;
    await expect(
      fs.stat(dirname((await launches())[0].path)),
    ).rejects.toThrow();
    await expect(runClaudeCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
    });
    expect((await launches()).length).toBe(1);
  });
});

// A child-process test double, not evidence that native Claude excludes sources.
// It uses actual HTTP initialization/discovery/calls against our controller.
const FAKE_CLAUDE = `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.PROBE_MODE;
if (args.includes('--version')) {
  console.log(mode === 'unsupported' ? '2.1.99 (Claude Code)' : mode === 'newer' ? '2.1.283 (Claude Code)' : '2.1.263 (Claude Code)');
  process.exit(0);
}
const path = args[args.indexOf('--mcp-config') + 1];
const config = JSON.parse(readFileSync(path, 'utf8'));
appendFileSync(process.env.PROBE_LOG, JSON.stringify({args, path, config, cwd: process.cwd(),
  env: Object.fromEntries(['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'NO_PROXY', 'no_proxy', 'PATH'].map(k => [k, process.env[k]]))}) + '\\n');
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
if (mode === 'extra-server') init.mcp_servers.push({name: 'claude.ai Linear', status: 'connected'});
if (mode === 'missing-tool') init.tools = ['Read'];
if (mode !== 'no-init') console.log(JSON.stringify(init));
let result = 'No tools called.';
if (mode === 'call') result = JSON.stringify(await rpc('tools/call', {name: 'lookup', arguments: {literal: 'value'}}));
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: mode === 'result-error', result}));
`;
