import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {CodexMcpError} from './harnesses/codexMcp.js';
import type {
  Harness,
  HarnessInput,
  HarnessRunOutput,
  McpServerConnections,
} from './harnesses/types.js';
import {runJob} from './index.js';
import * as controllerModule from './mcpMocks/controller.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, {recursive: true, force: true})),
  );
});

function scenario(overrides: Partial<IrScenario> = {}): IrScenario {
  return {
    id: 'linear',
    name: 'Linear',
    prompt: 'Read DYNO-1.',
    harnesses: [{id: 'claude-code'}],
    setup: [],
    fixtures: [],
    cliMocks: {},
    endpoints: [],
    mcpMocks: {
      linear: {
        tools: {
          get_issue: {
            inputSchema: {type: 'object'},
            response: {content: [{type: 'text', text: 'RESPONSE_SENTINEL'}]},
          },
          save_issue: {inputSchema: {type: 'object'}, response: {content: []}},
        },
      },
    },
    assertions: [
      {
        id: 'read',
        type: 'mcp.called',
        server: 'linear',
        tool: 'get_issue',
        input: {id: 'DYNO-1'},
      },
      {
        id: 'no-write',
        type: 'mcp.notCalled',
        server: 'linear',
        tool: 'save_issue',
      },
    ],
    ...overrides,
  };
}

async function fixture(
  mode: Mode = 'call',
  overrides: Partial<IrScenario> = {},
  harnessId: 'claude-code' | 'codex' | 'opencode' = 'claude-code',
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-mcp-runner-'));
  roots.push(root);
  const harness = new McpHarness(mode, harnessId);
  const job = {
    id: 'job.linear',
    harness: harnessId,
    iteration: 0,
    scenario: scenario({harnesses: [{id: harnessId}], ...overrides}),
  };
  const options = {
    scratchRoot: root,
    harnesses: [harness],
    experimentalMcp: true,
    timeoutMs: 3000,
  };
  return {root, harness, job, options};
}

describe('MCP runner lifecycle', () => {
  it.each(['call', 'negative', 'no-discovery'] as const)(
    'runs experimental OpenCode lifecycle: %s',
    async (mode) => {
      const {job, options} = await fixture(
        mode,
        mode === 'call' ? {} : {assertions: [scenario().assertions[1]!]},
        'opencode',
      );
      const result = await runJob(job, options);
      expect(result.status).toBe(
        mode === 'no-discovery' ? 'harness_failed' : 'passed',
      );
      expect(result.harnessVersion).toBe('1.18.26');
      await expect(
        runJob(job, {...options, experimentalMcp: false}),
      ).rejects.toThrow('not enabled');
    },
  );
  it.each(['call', 'negative', 'no-discovery'] as const)(
    'runs experimental Codex through the shared lifecycle: %s',
    async (mode) => {
      const {job, options, harness} = await fixture(
        mode,
        mode === 'call' ? {} : {assertions: [scenario().assertions[1]!]},
        'codex',
      );
      const result = await runJob(job, options);
      expect(result.status).toBe(
        mode === 'no-discovery' ? 'harness_failed' : 'passed',
      );
      expect(result.harnessVersion).toBe('0.153.4');
      expect(result.mcp?.ready).toBe(mode !== 'no-discovery');
      expect(result.mcp?.finalized).toBe(true);
      expect(harness.normalRuns).toBe(0);
      await expect(fetch(harness.urls[0]!)).rejects.toThrow();
    },
  );

  it('keeps public Codex MCP execution disabled before setup', async () => {
    const {job, options, harness} = await fixture('negative', {}, 'codex');
    await expect(
      runJob(job, {...options, experimentalMcp: false}),
    ).rejects.toThrow('not enabled');
    expect(harness.inputs).toEqual([]);
    expect(harness.preparedEnv).toBeUndefined();
  });

  it('reports safe Codex preparation failure categories and fails negative assertions', async () => {
    const {job, options, harness} = await fixture(
      'negative',
      {assertions: [scenario().assertions[1]!]},
      'codex',
    );
    vi.spyOn(harness, 'prepareMcp').mockResolvedValue({
      run: async () => {
        throw new CodexMcpError('not_ready');
      },
    });
    const result = await runJob(job, options);
    expect(result.status).toBe('harness_failed');
    expect(result.mcp?.failures).toContain('not_ready');
    expect(result.assertionResults).toEqual([]);
  });

  it('evaluates sealed controller evidence and reports only safe call records', async () => {
    const {job, options, harness} = await fixture();
    const result = await runJob(job, options);
    expect(result.status).toBe('passed');
    expect(result.harnessVersion).toBe('2.1.263');
    expect(
      result.assertionResults.map((assertion) => assertion.passed),
    ).toEqual([true, true]);
    expect(result.mcp).toEqual({
      ready: true,
      finalized: true,
      failures: [],
      calls: [
        {sequence: 1, server: 'linear', tool: 'get_issue', category: 'success'},
      ],
    });
    expect(JSON.stringify(result.mcp)).not.toMatch(
      /INPUT_SENTINEL|RESPONSE_SENTINEL|127\.0\.0\.1/,
    );
    expect(harness.normalRuns).toBe(0);
    await expect(fetch(harness.urls[0]!)).rejects.toThrow();
  });

  it('supports negative-only assertions but refuses synthetic readiness without discovery', async () => {
    for (const mode of ['negative', 'no-discovery'] as const) {
      const {job, options} = await fixture(mode, {
        assertions: [scenario().assertions[1]!],
      });
      const result = await runJob(job, options);
      expect(result.status).toBe(
        mode === 'negative' ? 'passed' : 'harness_failed',
      );
      expect(result.mcp?.ready).toBe(mode === 'negative');
      if (mode === 'no-discovery') expect(result.assertionResults).toEqual([]);
    }
  });

  it('seals before verify and keeps anyOf MCP observations cached', async () => {
    const {job, options, harness} = await fixture('call', {
      assertions: [
        {
          id: 'either',
          type: 'anyOf',
          steps: [
            {
              type: 'mcp.called',
              server: 'linear',
              tool: 'get_issue',
              input: {id: 'DYNO-1'},
            },
            {
              type: 'verify.command',
              command: `node -e 'const fs=require("node:fs"); fetch(fs.readFileSync("url.txt","utf8")).then(()=>process.exit(1),()=>{fs.writeFileSync("verified","yes")})'`,
              exitCode: 0,
            },
          ],
        },
      ],
    });
    const result = await runJob(job, options);
    expect(result.status).toBe('passed');
    expect(await readFile(join(result.workDir, 'verified'), 'utf8')).toBe(
      'yes',
    );
    expect(result.assertionResults[0]?.evidence).toMatchObject({
      kind: 'anyOf',
      branchIndex: 1,
      branches: [
        {passed: true, evidence: {kind: 'mcp', matchCount: 1}},
        {passed: true},
      ],
    });
    expect(result.mcp?.calls).toHaveLength(1);
    expect(harness.urls).toHaveLength(1);
  });

  it('fails cancellation during verify even when an MCP anyOf branch already passed', async () => {
    const {job, options, harness} = await fixture('call', {
      assertions: [
        {
          id: 'either',
          type: 'anyOf',
          steps: [
            {type: 'mcp.called', server: 'linear', tool: 'get_issue'},
            {
              type: 'verify.command',
              command: `exec node -e 'require("node:fs").writeFileSync("verify-started", "yes"); setInterval(() => {}, 1000)'`,
              exitCode: 0,
            },
          ],
        },
      ],
    });
    const abort = new AbortController();
    const pending = runJob(job, {...options, signal: abort.signal});
    try {
      await vi.waitFor(async () => {
        expect(harness.inputs).toHaveLength(1);
        expect(
          await readFile(
            join(harness.inputs[0]!.workDir, 'verify-started'),
            'utf8',
          ),
        ).toBe('yes');
      });
    } finally {
      abort.abort();
    }
    const result = await pending;
    expect(result.status).toBe('harness_failed');
    expect(result.mcp).toMatchObject({
      ready: true,
      finalized: true,
      failures: ['execution_failed'],
    });
    await expect(fetch(harness.urls[0]!)).rejects.toThrow();
  });

  it('keeps preparation on the original PATH and preserves CLI mock verification', async () => {
    const {job, options, harness} = await fixture('call', {
      cliMocks: {
        helper: {response: {exitCode: 0, stdout: 'CLI_FIXTURE', stderr: ''}},
      },
      assertions: [
        ...scenario().assertions,
        {
          id: 'verify',
          type: 'verify.command',
          command: 'helper',
          stdout: {equals: 'CLI_FIXTURE'},
        },
      ],
    });
    const result = await runJob(job, options);
    expect(result.status).toBe('passed');
    expect(harness.preparedEnv?.PATH).toBeUndefined();
    expect(harness.inputs[0]?.env.PATH).toContain('dynobox');
    expect(result.cliMockCalls).toHaveLength(1);
    expect(result.harnessCliMockCallCount).toBe(0);
  });

  it.each(['unknown', 'exhaust', 'failed', 'not-ready'] as const)(
    'fails infrastructure on %s before assertions or verify',
    async (mode) => {
      const {job, options, harness} = await fixture(mode, {
        assertions: [
          {
            id: 'none',
            type: 'mcp.notCalled',
            server: 'linear',
            tool: 'save_issue',
          },
          {
            id: 'verify',
            type: 'verify.command',
            command: 'touch should-not-exist',
            exitCode: 0,
          },
        ],
      });
      if (mode === 'exhaust')
        job.scenario.mcpMocks!.linear!.tools.get_issue = {
          inputSchema: {type: 'object'},
          responses: [{content: []}],
        };
      const result = await runJob(job, options);
      expect(result.status).toBe('harness_failed');
      expect(result.assertionResults).toEqual([]);
      expect(result.mcp?.failures.length).toBeGreaterThan(0);
      expect(result.diagnostics.join(' ')).not.toContain('SECRET_ERROR');
      await expect(
        readFile(join(result.workDir, 'should-not-exist')),
      ).rejects.toThrow();
      await expect(fetch(harness.urls[0]!)).rejects.toThrow();
    },
  );

  it('allows intentional tool errors and distinguishes unmatched assertions', async () => {
    const successful = await fixture();
    successful.job.scenario.mcpMocks!.linear!.tools.get_issue = {
      inputSchema: {type: 'object'},
      response: {content: [], isError: true},
    };
    expect((await runJob(successful.job, successful.options)).status).toBe(
      'passed',
    );
    const failed = await fixture('negative');
    const result = await runJob(failed.job, failed.options);
    expect(result.status).toBe('assertion_failed');
    expect(result.mcp?.failures).toEqual([]);
  });

  it('isolates concurrent invocations on one harness instance', async () => {
    const {job, options, harness} = await fixture();
    const results = await Promise.all([
      runJob(job, options),
      runJob({...job, id: 'second'}, options),
    ]);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(new Set(harness.urls).size).toBe(2);
    for (const result of results) expect(result.mcp?.calls).toHaveLength(1);
    for (const url of harness.urls) await expect(fetch(url)).rejects.toThrow();
  });

  it.each(['timeout', 'cancel'] as const)(
    'finalizes listeners on %s',
    async (mode) => {
      const {job, options, harness} = await fixture('wait');
      const abort = new AbortController();
      const pending = runJob(job, {
        ...options,
        signal: abort.signal,
        timeoutMs: mode === 'timeout' ? 150 : 3000,
      });
      if (mode === 'cancel') {
        await vi.waitFor(() => expect(harness.urls.length).toBe(1));
        abort.abort();
      }
      const result = await pending;
      expect(result.status).toBe('harness_failed');
      expect(result.mcp?.finalized).toBe(true);
      expect(result.mcp?.failures).toContain('not_ready');
      await expect(fetch(harness.urls[0]!)).rejects.toThrow();
    },
  );

  it('reflects controller cleanup failure before returning an otherwise passing result', async () => {
    const original = controllerModule.startMcpMockController;
    vi.spyOn(controllerModule, 'startMcpMockController').mockImplementation(
      async (...args) => {
        const controller = await original(...args);
        return {
          ...controller,
          finalize: async (outcome) => {
            const observation = await controller.finalize(outcome);
            return {...observation, failures: ['cleanup_failed']};
          },
        };
      },
    );
    const {job, options} = await fixture();
    const result = await runJob(job, options);
    expect(result.status).toBe('harness_failed');
    expect(result.mcp?.failures).toContain('cleanup_failed');
    expect(result.assertionResults).toEqual([]);
  });

  it('rejects an invalid direct-run MCP definition before setup', async () => {
    const {job, options, root} = await fixture();
    job.scenario.mcpMocks = {};
    job.scenario.setup = [`touch ${join(root, 'setup')}`];
    await expect(runJob(job, options)).rejects.toThrow('Invalid MCP');
    await expect(readFile(join(root, 'setup'))).rejects.toThrow();
  });
});

type Mode =
  | 'call'
  | 'negative'
  | 'no-discovery'
  | 'unknown'
  | 'exhaust'
  | 'failed'
  | 'not-ready'
  | 'wait';

class McpHarness implements Harness {
  readonly executable = 'claude';
  readonly urls: string[] = [];
  readonly inputs: HarnessInput[] = [];
  preparedEnv?: Record<string, string>;
  normalRuns = 0;
  constructor(
    private readonly mode: Mode,
    readonly id: 'claude-code' | 'codex' | 'opencode' = 'claude-code',
  ) {}
  async prepareMcp(input: Pick<HarnessInput, 'workDir' | 'env'>) {
    this.preparedEnv = {...input.env};
    return {
      run: (runInput: HarnessInput, servers: McpServerConnections) =>
        this.invoke(runInput, servers),
    };
  }
  async run(): Promise<HarnessRunOutput> {
    this.normalRuns++;
    throw new Error('Normal harness path must not run MCP jobs.');
  }
  private async invoke(input: HarnessInput, servers: McpServerConnections) {
    const url = servers.linear!.url;
    this.urls.push(url);
    this.inputs.push(input);
    await writeFile(join(input.workDir, 'url.txt'), url);
    const client = new Client({name: 'runner-test', version: '1'});
    try {
      if (this.mode !== 'no-discovery') {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url)) as Transport,
        );
        await client.listTools();
      }
      if (this.mode === 'wait')
        await new Promise((_resolve, reject) => {
          const fail = () => {
            clearTimeout(timer);
            reject(new Error('SECRET_ERROR'));
          };
          const timer = setTimeout(fail, input.timeoutMs);
          input.signal?.addEventListener('abort', fail, {once: true});
          if (input.signal?.aborted) fail();
        });
      if (this.mode === 'failed') throw new Error('SECRET_ERROR ' + url);
      if (['call', 'exhaust', 'unknown'].includes(this.mode)) {
        try {
          await client.callTool({
            name: this.mode === 'unknown' ? 'unknown' : 'get_issue',
            arguments: {id: 'DYNO-1', private: 'INPUT_SENTINEL'},
          });
          if (this.mode === 'exhaust')
            await client.callTool({name: 'get_issue', arguments: {}});
        } catch {
          // The controller must still fail a job whose harness ignores MCP errors.
        }
      }
      return {
        harnessReady: this.mode !== 'not-ready',
        output: {
          exitCode: 0,
          stdout: 'done',
          stderr: '',
          durationMs: 5,
          metadata: {
            mcpHarnessVersion:
              this.id === 'codex'
                ? '0.153.4'
                : this.id === 'opencode'
                  ? '1.18.26'
                  : '2.1.263',
          },
        },
      };
    } finally {
      await client.close();
    }
  }
  extractResult(output: HarnessRunOutput) {
    return {
      exitCode: output.exitCode,
      durationMs: output.durationMs,
      transcript: output.stdout,
      finalMessage: 'done',
      toolEvents: [],
    };
  }
}
