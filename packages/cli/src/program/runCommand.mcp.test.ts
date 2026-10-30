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

async function fixture(mode = 'call', mixed = false) {
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
        ...(mixed
          ? [
              {
                name: 'Plain',
                prompt: 'Reply.',
                assertions: [{type: 'finalMessage.contains', text: 'done'}],
              },
            ]
          : []),
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
        MCP_TEST_LOG: log,
        MCP_TEST_MODE: mode,
      } as Record<string, string>,
    },
  };
}

describe('MCP CLI execution', () => {
  it.each([false, true])(
    'runs valid siblings in one file (supported MCP sibling: %s)',
    async (supportedSibling) => {
      const {root, path, options} = await fixture('call', true);
      const source = JSON.parse(await readFile(path, 'utf8'));
      source.scenarios[0].harnesses = supportedSibling
        ? ['cursor', 'claude-code']
        : ['cursor'];
      await writeFile(path, JSON.stringify(source));
      const result = await executeCli(
        ['run', path, '--reporter', 'json'],
        options,
      );
      expect(result.exitCode).toBe(configErrorExitCode);
      expect(result.stderr).toContain(
        'Lookup (cursor): MCP mocking is unavailable for Cursor',
      );
      const output = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const summary = output.pop();
      expect(output).toHaveLength(supportedSibling ? 2 : 1);
      expect(output.every((job) => job.status === 'passed')).toBe(true);
      expect(summary.status).toBe('failed');
      expect(summary.totals).toMatchObject({
        jobs: supportedSibling ? 2 : 1,
        passed: supportedSibling ? 2 : 1,
        configErrors: 1,
      });
      if (!supportedSibling) {
        await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
      }
    },
  );

  it('reports scheduling failure without a false scenario-filter error', async () => {
    const {root, path, options} = await fixture('call', true);
    const source = JSON.parse(await readFile(path, 'utf8'));
    const plain = {...source, scenarios: [source.scenarios[1]]};
    source.scenarios = [source.scenarios[0]];
    source.harnesses = ['cursor'];
    await writeFile(path, JSON.stringify(source));
    await writeFile(join(root, 'plain.dyno.yaml'), JSON.stringify(plain));
    const result = await executeCli(
      ['run', root, '--scenario', 'Lookup', '--reporter', 'json'],
      options,
    );
    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      'Lookup (cursor): MCP mocking is unavailable for Cursor',
    );
    expect(result.stderr).not.toContain('No scenarios matched');
    expect(result.stdout).toBe('');
    await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
  });

  it.each([false, true])(
    'reports each unsupported file and runs valid files (all unsupported: %s)',
    async (allUnsupported) => {
      const {root, path, options} = await fixture();
      const source = JSON.parse(await readFile(path, 'utf8'));
      source.harnesses = ['cursor'];
      for (const name of ['a-unsupported', 'b-unsupported']) {
        source.scenarios[0].setup = [`touch ${join(root, name + '-ran')}`];
        await writeFile(
          join(root, name + '.dyno.yaml'),
          JSON.stringify(source),
        );
      }
      if (allUnsupported) await rm(path);
      const result = await executeCli(
        ['run', root, '--reporter', 'json'],
        options,
      );
      expect(result.exitCode).toBe(configErrorExitCode);
      for (const name of ['a-unsupported', 'b-unsupported']) {
        expect(result.stderr).toContain(name + '.dyno.yaml');
        await expect(readFile(join(root, name + '-ran'))).rejects.toThrow();
      }
      if (allUnsupported) {
        expect(result.stdout).toBe('');
        await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
      } else {
        const [job, summary] = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(job.status).toBe('passed');
        expect(summary.status).toBe('failed');
        expect(summary.totals).toMatchObject({
          jobs: 1,
          passed: 1,
          configErrors: 2,
        });
        await expect(readFile(join(root, 'setup-ran'))).resolves.toBeDefined();
      }
    },
  );

  it('runs a YAML dyno through Claude preparation, controller, assertions and v3 JSON', async () => {
    const {path, options, log} = await fixture();
    const result = await executeCli(
      ['run', path, '--reporter', 'json'],
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
    const grants = launches[1].args.indexOf('--allowedTools');
    expect(launches[1].args.slice(grants, grants + 3)).toEqual([
      '--allowedTools',
      'mcp__linear__get_issue',
      'mcp__linear__save_issue',
    ]);
    expect(launches[1].args).not.toContain('bypassPermissions');
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

  it.each([
    ['failed', 'not_ready', '"subtype":"init"'],
    ['exit', 'execution_failed', 'PRIVATE_STDOUT'],
    ['malformed', 'execution_failed', 'PRIVATE_STDOUT'],
    ['probe-failed', 'unsupported_version', 'PRIVATE_STDOUT'],
    ['timeout', 'timed_out', 'PRIVATE_STDOUT'],
  ])(
    'preserves %s output only in local debug files',
    async (mode, category, stdoutText) => {
      for (const debug of [false, true]) {
        const {path, options} = await fixture(mode);
        if (mode === 'timeout') options.timeoutMs = 500;
        const result = await executeCli(
          ['run', path, '--reporter', 'json', ...(debug ? ['--debug'] : [])],
          options,
        );
        expect(result.exitCode).toBe(1);
        const job = JSON.parse(result.stdout.split('\n')[0]!);
        expect(job.status).toBe('harness_failed');
        expect(job.mcp.failures).toContain(category);
        expect(result.stdout + result.stderr).not.toMatch(
          /PRIVATE_STDOUT|PRIVATE_ERROR|127\.0\.0\.1/,
        );
        if (debug) {
          expect(
            await readFile(job.debugLogPaths.chatHistory, 'utf8'),
          ).toContain(stdoutText);
          expect(await readFile(job.debugLogPaths.stderr, 'utf8')).toContain(
            'PRIVATE_ERROR',
          );
        } else {
          expect(job.debugLogPaths).toBeUndefined();
          for (const name of [
            'dynobox-chat-history.jsonl',
            'dynobox-stderr.log',
          ])
            await expect(
              readFile(join(job.artifacts[0].path, name)),
            ).rejects.toThrow();
        }
      }
    },
  );

  it('grants only the declared MCP tools in a run that mixes scenarios', async () => {
    const {path, options, log} = await fixture('call', true);
    const result = await executeCli(
      ['run', path, '--reporter', 'json'],
      options,
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const jobs = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .slice(0, -1); // The last line is the run summary.
    expect(jobs.map((job) => job.status)).toEqual(['passed', 'passed']);
    const launches = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const grants = launches[1].args.indexOf('--allowedTools');
    expect(launches[1].args.slice(grants, grants + 3)).toEqual([
      '--allowedTools',
      'mcp__linear__get_issue',
      'mcp__linear__save_issue',
    ]);
    expect(
      launches[2].args.some((arg: string) => arg.startsWith('--allowedTools')),
    ).toBe(false);
  });

  it.each([
    'unsupported',
    'custom-upload',
    'upload-no-token',
    'upload-with-token',
  ] as const)('rejects %s before setup or invocation', async (mode) => {
    const {path, root, options, log} = await fixture();
    const upload = mode !== 'unsupported';
    options.env.HOME = join(root, 'missing-home');
    options.env.DYNOBOX_TOKEN =
      mode === 'upload-with-token' ? 'test-token' : '';
    options.env.DYNOBOX_UPLOAD_URL = '';
    if (mode === 'custom-upload')
      options.env.DYNOBOX_UPLOAD_URL = 'http://127.0.0.1:9/upload';
    const args = upload ? ['--save-run'] : ['--harness', 'cursor'];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await executeCli(['run', path, ...args], options);
    expect(result.exitCode).toBe(configErrorExitCode);
    expect(result.stderr).toContain(
      upload ? 'local-only' : 'plugin-provided MCP servers cannot be isolated',
    );
    await expect(readFile(join(root, 'setup-ran'))).rejects.toThrow();
    await expect(readFile(log)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const CHILD = `#!${process.execPath}
import {appendFileSync, readFileSync, writeSync} from 'node:fs';
const args = process.argv.slice(2);
const path = args[args.indexOf('--mcp-config') + 1];
appendFileSync(process.env.MCP_TEST_LOG, JSON.stringify({args, path}) + '\\n');
const mode = process.env.MCP_TEST_MODE;
if (mode === 'probe-failed' && args.includes('--version')) {
  console.log('PRIVATE_STDOUT'); console.error('PRIVATE_ERROR'); process.exit(1);
}
if (args.includes('--version')) {console.log('2.1.263 (Claude Code)'); process.exit(0);}
if (!args.includes('--mcp-config')) {console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'done'})); process.exit(0);}
if (['exit', 'malformed', 'timeout'].includes(mode)) {
  console.error('PRIVATE_ERROR');
  console.log(mode === 'malformed' ? 'PRIVATE_STDOUT' : JSON.stringify({type: 'system', subtype: 'status', message: 'PRIVATE_STDOUT'}));
  if (mode === 'exit') process.exit(1);
  await new Promise(() => setInterval(() => {}, 1000));
}
const config = JSON.parse(readFileSync(path, 'utf8'));
const url = config.mcpServers.linear.url;
let id = 0;
async function rpc(method, params) {
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params})});
  return response.json();
}
await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'cli-test', version: '1'}});
await rpc('tools/list', {});
// Emit stderr before the init event can make the adapter stop this process.
if (mode === 'failed') writeSync(2, 'PRIVATE_ERROR ' + url + '\\n');
console.log(JSON.stringify({type: 'system', subtype: 'init', tools: ['mcp__linear__get_issue', 'mcp__linear__save_issue'], mcp_servers: [{name: 'linear', status: mode === 'failed' ? 'failed' : 'connected'}]}));
if (mode === 'failed') process.exit(1);
if (mode === 'call') {
  await rpc('tools/call', {name: 'get_issue', arguments: {id: 'INPUT_SENTINEL'}});
  console.log(JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'mcp__linear__get_issue', tool_input: {id: 'INPUT_SENTINEL'}}));
}
console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'done'}));
`;
