import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {ClaudeCodeHarness} from '@dynobox/runner-local';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {executeCli} from './execute.js';
import {configErrorExitCode} from './exitCodes.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, {recursive: true, force: true})),
  );
});

async function fixture(mode = 'call') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-cli-mcp-'));
  roots.push(root);
  const path = join(root, 'linear.dyno.yaml');
  const executable = join(root, 'claude');
  const log = join(root, 'launches.jsonl');
  await writeFile(executable, CHILD, {mode: 0o755});
  await writeFile(
    path,
    JSON.stringify({
      name: 'Linear MCP',
      harnesses: ['claude-code'],
      scenarios: [
        {
          name: 'Lookup',
          prompt: 'Read DYNO-1.',
          setup: [`touch ${join(root, 'setup-ran')}`],
          mcpMocks: {
            linear: {
              tools: {
                get_issue: {
                  inputSchema: {type: 'object'},
                  response: {
                    content: [{type: 'text', text: 'RESPONSE_SENTINEL'}],
                  },
                },
                save_issue: {
                  inputSchema: {type: 'object'},
                  response: {content: []},
                },
              },
            },
          },
          assertions: [
            {
              type: 'mcp.called',
              server: 'linear',
              tool: 'get_issue',
              input: {id: 'INPUT_SENTINEL'},
            },
            {type: 'mcp.notCalled', server: 'linear', tool: 'save_issue'},
            {type: 'tool.called', tool: 'mcp'},
            {
              type: 'anyOf',
              steps: [
                {
                  type: 'mcp.called',
                  server: 'linear',
                  tool: 'get_issue',
                  input: {id: 'INPUT_SENTINEL'},
                },
                {
                  type: 'verify.command',
                  command: 'node -e "process.exit(0)"',
                  exitCode: 0,
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  return {
    root,
    path,
    log,
    options: {
      scratchRoot: root,
      harnesses: [new ClaudeCodeHarness({executable})],
      timeoutMs: 3000,
      env: {
        DYNOBOX_EXPERIMENTAL_MCP: '1',
        MCP_TEST_LOG: log,
        MCP_TEST_MODE: mode,
      },
    },
  };
}

describe('MCP CLI execution', () => {
  it('runs a YAML dyno through Claude preparation, controller, assertions and v3 JSON', async () => {
    const {path, options, log} = await fixture();
    const result = await executeCli(
      [
        'run',
        path,
        '--reporter',
        'json',
        '--allow-mcp-tool',
        'linear/get_issue',
      ],
      options,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const [job, summary] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(job.schema).toBe('dynobox.report.v3');
    expect(summary.schema).toBe('dynobox.report.v3');
    expect(job.mcp).toMatchObject({
      ready: true,
      finalized: true,
      failures: [],
      callCount: 1,
    });
    expect(job.mcp.calls).toEqual([
      {sequence: 1, server: 'linear', tool: 'get_issue', category: 'success'},
    ]);
    expect(job.assertions[0].mcp).toEqual({
      server: 'linear',
      tool: 'get_issue',
      hasInput: true,
      callCount: 1,
      matchCount: 1,
    });
    expect(job.assertions[3].mcpBranches).toEqual([
      {
        branchIndex: 1,
        passed: true,
        server: 'linear',
        tool: 'get_issue',
        hasInput: true,
        callCount: 1,
        matchCount: 1,
      },
    ]);
    expect(result.stdout).not.toMatch(
      /INPUT_SENTINEL|RESPONSE_SENTINEL|PRIVATE_ERROR|127\.0\.0\.1/,
    );
    const launches = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(launches).toHaveLength(2);
    expect(launches[1].args).toContain('--allowedTools=mcp__linear__get_issue');
    expect(launches[1].args).not.toContain('bypassPermissions');
    expect(launches[0].path).toBe(launches[1].path);
    await expect(readFile(launches[1].path)).rejects.toThrow();
    await expect(readFile(dirname(launches[1].path))).rejects.toThrow();
  });

  it('returns assertion_failed when a required MCP call is absent', async () => {
    const {path, options} = await fixture('negative');
    const result = await executeCli(
      ['run', path, '--reporter', 'json'],
      options,
    );
    expect(result.exitCode).toBe(1);
    const job = JSON.parse(result.stdout.split('\n')[0]!);
    expect(job.status).toBe('assertion_failed');
    expect(job.mcp.ready).toBe(true);
    expect(job.mcp.callCount).toBe(0);
    expect(job.assertions[0].mcp.matchCount).toBe(0);
    expect(job.assertions[1].passed).toBe(true);
  });

  it('returns safe failure categories for rejected startup', async () => {
    const {path, options} = await fixture('failed');
    const result = await executeCli(
      ['run', path, '--reporter', 'json'],
      options,
    );
    expect(result.exitCode).toBe(1);
    const job = JSON.parse(result.stdout.split('\n')[0]!);
    expect(job.status).toBe('harness_failed');
    expect(job.mcp.failures).toContain('not_ready');
    expect(result.stdout + result.stderr).not.toMatch(
      /PRIVATE_ERROR|INPUT_SENTINEL|RESPONSE_SENTINEL|127\.0\.0\.1/,
    );
  });

  it.each(['linear/missing', 'unknown/get_issue', 'linear/get_issue/extra'])(
    'rejects undeclared grant %s',
    async (grant) => {
      const {path, root, options, log} = await fixture();
      const result = await executeCli(
        ['run', path, '--allow-mcp-tool', grant],
        options,
      );
      expect(result.exitCode).toBe(configErrorExitCode);
      expect(result.stderr).toContain('must name a declared mock server/tool');
      await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
      await expect(readFile(log)).rejects.toThrow();
    },
  );

  it.each(['disabled', 'unsupported', 'upload'] as const)(
    'rejects %s before setup or invocation',
    async (mode) => {
      const {path, root, options, log} = await fixture();
      if (mode === 'disabled') options.env.DYNOBOX_EXPERIMENTAL_MCP = '0';
      const args =
        mode === 'upload'
          ? ['--save-run']
          : mode === 'unsupported'
            ? ['--harness', 'cursor']
            : [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await executeCli(['run', path, ...args], options);
      expect(result.exitCode).toBe(configErrorExitCode);
      expect(result.stderr).toContain(
        mode === 'upload' ? 'local-only' : 'not enabled',
      );
      await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
      await expect(readFile(log)).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

const CHILD = `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
const args = process.argv.slice(2);
const path = args[args.indexOf('--mcp-config') + 1];
appendFileSync(process.env.MCP_TEST_LOG, JSON.stringify({args, path}) + '\\n');
if (args.includes('--version')) {console.log('2.1.263 (Claude Code)'); process.exit(0);}
const config = JSON.parse(readFileSync(path, 'utf8'));
const url = config.mcpServers.linear.url;
let id = 0;
async function rpc(method, params) {
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  return response.json();
}
await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'cli-test', version: '1'}});
await rpc('tools/list', {});
const mode = process.env.MCP_TEST_MODE;
console.log(JSON.stringify({type: 'system', subtype: 'init', tools: ['mcp__linear__get_issue', 'mcp__linear__save_issue'], mcp_servers: [{name: 'linear', status: mode === 'failed' ? 'failed' : 'connected'}]}));
if (mode === 'failed') {console.error('PRIVATE_ERROR ' + url); process.exit(1);}
if (mode === 'call') {
  await rpc('tools/call', {name: 'get_issue', arguments: {id: 'INPUT_SENTINEL'}});
  console.log(JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'mcp__linear__get_issue', tool_input: {id: 'INPUT_SENTINEL'}}));
}
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'done'}));
`;
