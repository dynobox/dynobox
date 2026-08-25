import type {
  LocalRunnerJob,
  LocalRunnerResult,
  LocalRunnerStatus,
} from '@dynobox/runner-local';
import type {HarnessId, PermissionMode} from '@dynobox/sdk';
import {describe, expect, it} from 'vitest';

import {createRenderContext, visibleLength} from '../terminal/index.js';
import {buildGroupedRunView, renderGroupedRun} from './groupedRun.js';
import type {RunDynoGroup} from './plan.js';
import {renderRunSummary} from './summary.js';

const ctx = createRenderContext();

type JobSpec = {
  scenarioId?: string;
  scenarioName?: string;
  harness?: HarnessId;
  model?: string;
  permissionMode?: PermissionMode;
  iteration?: number;
  assertionCount?: number;
  assertionLabel?: string;
  assertionTool?: 'shell' | 'edit_file';
  cliMockNames?: string[];
};

function makeJob(spec: JobSpec = {}): LocalRunnerJob {
  const scenarioId = spec.scenarioId ?? 'scenario.test';
  const harness = spec.harness ?? 'claude-code';
  const iteration = spec.iteration ?? 0;
  const assertionCount = spec.assertionCount ?? 2;
  return {
    id: `${scenarioId}.${harness}${spec.model === undefined ? '' : `.${spec.model}`}.iteration.${iteration}`,
    scenario: {
      id: scenarioId,
      name: spec.scenarioName ?? 'test scenario',
      prompt: 'Run a test.',
      harnesses: [
        {
          id: harness,
          ...(spec.permissionMode === undefined
            ? {}
            : {permissionMode: spec.permissionMode}),
        },
      ],
      setup: [],
      fixtures: [],
      cliMocks: Object.fromEntries(
        (spec.cliMockNames ?? []).map((name) => [
          name,
          {response: {exitCode: 0, stdout: '', stderr: ''}},
        ]),
      ),
      endpoints: [],
      assertions: Array.from({length: assertionCount}, (_, index) => ({
        id: `${scenarioId}.assert.${index}`,
        type: 'tool.called' as const,
        tool: spec.assertionTool ?? 'shell',
        ...(spec.assertionLabel === undefined
          ? {}
          : {label: spec.assertionLabel}),
      })),
    },
    harness,
    ...(spec.model === undefined ? {} : {model: spec.model}),
    ...(spec.permissionMode === undefined
      ? {}
      : {permissionMode: spec.permissionMode}),
    iteration,
  };
}

type ResultSpec = {
  status?: LocalRunnerStatus;
  failedAssertionIndexes?: number[];
  totalMs?: number;
  assertionsMs?: number;
  cliMockCalls?: LocalRunnerResult['cliMockCalls'];
  diagnostics?: string[];
  verificationFailed?: boolean;
};

function makeResult(
  job: LocalRunnerJob,
  spec: ResultSpec = {},
): LocalRunnerResult {
  const status = spec.status ?? 'passed';
  const failed = new Set(spec.failedAssertionIndexes ?? []);
  const assertionResults =
    status === 'setup_failed' || status === 'harness_failed'
      ? []
      : job.scenario.assertions.map((assertion, index) => ({
          assertionId: assertion.id,
          type: assertion.type,
          passed: !failed.has(index),
          message: failed.has(index) ? 'not matched' : 'ok',
        }));
  return {
    jobId: job.id,
    scenarioId: job.scenario.id,
    harness: job.harness,
    harnessVersion: null,
    iteration: job.iteration,
    status,
    passed: status === 'passed',
    workDir: '/tmp/work',
    setupResult: {success: status !== 'setup_failed', logs: []},
    httpEvents: [],
    harnessCliMockCallCount: 0,
    cliMockCalls: spec.cliMockCalls ?? [],
    artifacts: [],
    assertionResults,
    verificationFailed: spec.verificationFailed ?? false,
    diagnostics:
      spec.diagnostics ??
      (status === 'harness_failed' ? ['codex exited with code 1'] : []),
    warnings: [],
    timing: {
      setupMs: 0,
      harnessMs: 0,
      assertionsMs: spec.assertionsMs ?? 0,
      totalMs: spec.totalMs ?? 4200,
    },
  };
}

function dynoOf(
  jobs: LocalRunnerJob[],
  overrides: Partial<RunDynoGroup> = {},
): RunDynoGroup {
  return {
    name: 'package-script-check',
    path: 'checks.dyno.ts',
    jobs,
    ...overrides,
  };
}

describe('buildGroupedRunView', () => {
  it('groups jobs by dyno, scenario, and harness label', () => {
    const jobs = [
      makeJob({scenarioId: 'scenario.a', scenarioName: 'a'}),
      makeJob({scenarioId: 'scenario.a', scenarioName: 'a', harness: 'codex'}),
      makeJob({scenarioId: 'scenario.b', scenarioName: 'b'}),
    ];
    const results = jobs.map((job) => makeResult(job));

    const view = buildGroupedRunView([dynoOf(jobs)], results);

    expect(view).toHaveLength(1);
    expect(view[0]?.label).toBe('package-script-check');
    expect(view[0]?.scenarios.map((scenario) => scenario.name)).toEqual([
      'a',
      'b',
    ]);
    expect(
      view[0]?.scenarios[0]?.harnessGroups.map((group) => group.label),
    ).toEqual(['claude-code', 'codex']);
  });

  it('falls back to the dyno path when no name is authored', () => {
    const jobs = [makeJob()];
    const view = buildGroupedRunView(
      [{path: 'checks.dyno.ts', jobs}],
      jobs.map((job) => makeResult(job)),
    );

    expect(view[0]?.label).toBe('checks.dyno.ts');
  });

  it('collects iterations under one harness group', () => {
    const jobs = [makeJob({iteration: 0}), makeJob({iteration: 1})];
    const view = buildGroupedRunView(
      [dynoOf(jobs)],
      jobs.map((job) => makeResult(job)),
    );

    expect(view[0]?.scenarios[0]?.harnessGroups[0]?.entries).toHaveLength(2);
  });

  it('pairs results positionally when dynos produce identical job ids', () => {
    // Two dyno files with the same scenario name/harness yield identical
    // job ids; each dyno group must still get its own result.
    const jobA = makeJob();
    const jobB = makeJob();
    const results = [
      makeResult(jobA),
      makeResult(jobB, {
        status: 'assertion_failed',
        failedAssertionIndexes: [0],
      }),
    ];

    const view = buildGroupedRunView(
      [
        dynoOf([jobA]),
        dynoOf([jobB], {name: 'other-dyno', path: 'other.dyno.ts'}),
      ],
      results,
    );

    expect(
      view[0]?.scenarios[0]?.harnessGroups[0]?.entries[0]?.result.passed,
    ).toBe(true);
    expect(
      view[1]?.scenarios[0]?.harnessGroups[0]?.entries[0]?.result.passed,
    ).toBe(false);
  });

  it('throws when results are misaligned and job ids are unique', () => {
    const jobs = [
      makeJob({scenarioId: 'scenario.a'}),
      makeJob({scenarioId: 'scenario.b'}),
    ];
    const results = [makeResult(jobs[1]!), makeResult(jobs[0]!)];

    expect(() => buildGroupedRunView([dynoOf(jobs)], results)).toThrow(
      /Result\/job mismatch at index 0/,
    );
  });
});

describe('renderGroupedRun', () => {
  it('omits harness labels from rows when there is one harness label', () => {
    const jobs = [makeJob({assertionCount: 3})];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job)),
      ctx,
    });

    expect(output).toContain('  package-script-check\n');
    expect(output).toContain('    test scenario\n');
    expect(output).toContain('✓ 3 assertions');
    expect(output).not.toContain('claude-code');
  });

  it('renders full metadata for one configured harness', () => {
    const jobs = [makeJob({harness: 'opencode', model: 'openai/gpt-5.4-mini'})];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job)),
      ctx,
    });

    expect(output).toContain(
      '      opencode · model: openai/gpt-5.4-mini\n        ✓ 2 assertions',
    );
    expect(output).not.toContain('...');
  });

  it('wraps full harness metadata to the render width', () => {
    const jobs = [
      makeJob({
        harness: 'opencode',
        model: 'openai/gpt-5.4-mini',
        permissionMode: 'dangerous',
      }),
    ];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job)),
      ctx: createRenderContext({terminalWidth: 40}),
    });

    expect(output.replace(/\s+/g, ' ')).toContain(
      'opencode · model: openai/gpt-5.4-mini · mode: dangerous',
    );
    expect(
      output
        .trimEnd()
        .split('\n')
        .every((line) => visibleLength(line) <= 40),
    ).toBe(true);
  });

  it('renders full harness metadata above results when there are multiple labels', () => {
    const jobs = [
      makeJob({model: 'sonnet'}),
      makeJob({harness: 'opencode', model: 'openai/gpt-5.4-mini'}),
    ];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job)),
      ctx,
    });

    expect(output).toContain(
      '      claude-code · model: sonnet\n        ✓ 2 assertions',
    );
    expect(output).toContain(
      '      opencode · model: openai/gpt-5.4-mini\n        ✓ 2 assertions',
    );
    expect(output).not.toContain('...');
  });

  it('shows failed assertions below a failed row', () => {
    const jobs = [makeJob()];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [
        makeResult(jobs[0]!, {
          status: 'assertion_failed',
          failedAssertionIndexes: [1],
        }),
      ],
      ctx,
    });

    expect(output).toContain('✗ 1 of 2 failed');
    expect(output).toContain('✗ tool.called(shell)');
    expect(output).not.toContain('✓ tool.called(shell)');
  });

  it('uses assertion definitions from the failed dyno when assertion ids collide', () => {
    const jobA = makeJob({
      assertionLabel: 'alpha assertion',
      assertionTool: 'shell',
    });
    const jobB = makeJob({
      assertionLabel: 'beta assertion',
      assertionTool: 'edit_file',
    });
    const output = renderGroupedRun({
      dynos: [
        dynoOf([jobA]),
        dynoOf([jobB], {name: 'other-dyno', path: 'other.dyno.ts'}),
      ],
      results: [
        makeResult(jobA, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
        makeResult(jobB),
      ],
      ctx,
    });

    expect(output).toContain('alpha assertion  tool.called(shell)');
    expect(output).not.toContain('beta assertion  tool.called(edit_file)');
  });

  it('renders setup failures as job errors, not assertion failures', () => {
    const jobs = [makeJob()];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [makeResult(jobs[0]!, {status: 'setup_failed'})],
      ctx,
    });

    expect(output).toContain('✗ setup failed');
    expect(output).not.toContain('of 2 failed');
  });

  it('renders harness failures with diagnostics', () => {
    const jobs = [makeJob()];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [makeResult(jobs[0]!, {status: 'harness_failed'})],
      ctx,
    });

    expect(output).toContain('✗ harness failed');
    expect(output).toContain('codex exited with code 1');
  });

  it('renders diagnostics-backed assertion failures as verification failures', () => {
    const jobs = [makeJob()];
    const results = [
      makeResult(jobs[0]!, {
        status: 'assertion_failed',
        verificationFailed: true,
        diagnostics: ['CLI mock exhausted its configured responses.'],
      }),
    ];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results,
      ctx,
    });
    const verboseOutput = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results,
      ctx: createRenderContext({mode: 'verbose'}),
    });

    expect(output).toContain('✗ verification failed');
    expect(output).toContain('CLI mock exhausted its configured responses.');
    expect(output).not.toContain('0 of 2 failed');
    expect(verboseOutput).toContain('2 of 2 passed; verification failed');
    expect(verboseOutput).toContain(
      'CLI mock exhausted its configured responses.',
    );
  });

  it('labels assertion and verification failures together', () => {
    const jobs = [makeJob()];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [
        makeResult(jobs[0]!, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
          verificationFailed: true,
          diagnostics: ['CLI mock exhausted its configured responses.'],
        }),
      ],
      ctx,
    });

    expect(output).toContain('✗ 1 of 2 failed; verification failed');
    expect(output).toContain('CLI mock exhausted its configured responses.');
  });

  it('renders verification diagnostics for failed iterations', () => {
    const jobs = [makeJob({iteration: 0}), makeJob({iteration: 1})];
    const results = [
      makeResult(jobs[0]!),
      makeResult(jobs[1]!, {
        status: 'assertion_failed',
        verificationFailed: true,
        diagnostics: ['CLI mock handler failed.'],
      }),
    ];
    const output = renderGroupedRun({dynos: [dynoOf(jobs)], results, ctx});

    expect(output).toContain('iter 2 ✗ verification failed');
    expect(output).toContain('CLI mock handler failed.');
  });

  it('marks passing zero-assertion jobs explicitly', () => {
    const jobs = [makeJob({assertionCount: 0})];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job)),
      ctx,
    });

    expect(output).toContain('✓ no assertions');
  });

  it('labels zero-assertion verification failures without a passing count', () => {
    const jobs = [makeJob({assertionCount: 0})];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [
        makeResult(jobs[0]!, {
          status: 'assertion_failed',
          verificationFailed: true,
          diagnostics: ['CLI mock handler failed.'],
        }),
      ],
      ctx: createRenderContext({mode: 'verbose'}),
    });

    expect(output).toContain('assertions verification failed');
    expect(output).not.toContain('0 of 0 passed');
  });

  it('renders a job fraction and sparkline for multi-iteration runs', () => {
    const jobs = [0, 1, 2, 3, 4].map((iteration) => makeJob({iteration}));
    const results = jobs.map((job, index) =>
      makeResult(job, {
        ...(index === 1 || index === 2
          ? {status: 'assertion_failed', failedAssertionIndexes: [0]}
          : {}),
      }),
    );
    const output = renderGroupedRun({dynos: [dynoOf(jobs)], results, ctx});

    expect(output).toContain('✗ 2/5 failed   .FF..');
    expect(output).toContain('iter 2 ✗ tool.called(shell)');
    expect(output).toContain('iter 3 ✗ tool.called(shell)');
    // Failed iterations keep their expected/observed evidence.
    expect(output).toContain('expected  shell tool call');
    expect(output).toContain('observed  no shell tool calls observed');
  });

  it('shows job error diagnostics for failed iterations', () => {
    const jobs = [makeJob({iteration: 0}), makeJob({iteration: 1})];
    const results = [
      makeResult(jobs[0]!),
      makeResult(jobs[1]!, {status: 'harness_failed'}),
    ];
    const output = renderGroupedRun({dynos: [dynoOf(jobs)], results, ctx});

    expect(output).toContain('iter 2 ✗ harness failed');
    expect(output).toContain('codex exited with code 1');
  });

  it('attaches debug log paths by job reference when job ids duplicate across dynos', () => {
    const jobA = makeJob();
    const jobB = makeJob();
    const debugLogPaths = new Map([
      [
        jobA,
        {
          transcript: '/tmp/alpha/dynobox-transcript.log',
          cliMocks: '/tmp/alpha/dynobox-cli-mocks.json',
        },
      ],
      [jobB, {transcript: '/tmp/beta/dynobox-transcript.log'}],
    ]);
    const output = renderGroupedRun({
      dynos: [
        dynoOf([jobA]),
        dynoOf([jobB], {name: 'other-dyno', path: 'other.dyno.ts'}),
      ],
      results: [makeResult(jobA), makeResult(jobB)],
      ctx: createRenderContext({mode: 'debug'}),
      debugLogPaths,
    });

    expect(output).toContain(
      'log       transcript /tmp/alpha/dynobox-transcript.log',
    );
    expect(output).toContain(
      'log       transcript /tmp/beta/dynobox-transcript.log',
    );
    expect(output).toContain(
      'log       cli_mocks /tmp/alpha/dynobox-cli-mocks.json',
    );
  });

  it('separates multiple dynos into top-level groups', () => {
    const dynoA = dynoOf([
      makeJob({scenarioId: 'scenario.a', scenarioName: 'a'}),
    ]);
    const dynoB: RunDynoGroup = {
      name: 'skill-authoring',
      path: 'skills.dyno.ts',
      jobs: [makeJob({scenarioId: 'scenario.b', scenarioName: 'b'})],
    };
    const output = renderGroupedRun({
      dynos: [dynoA, dynoB],
      results: [...dynoA.jobs, ...dynoB.jobs].map((job) => makeResult(job)),
      ctx,
    });

    expect(output).toContain('  package-script-check\n');
    expect(output).toContain('\n\n  skill-authoring\n');
  });

  it('expands passing jobs with phase and assertion details in verbose mode', () => {
    const jobs = [makeJob()];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: jobs.map((job) => makeResult(job, {assertionsMs: 1200})),
      ctx: createRenderContext({mode: 'verbose'}),
    });

    expect(output).toContain('setup');
    expect(output).toContain('assertions');
    expect(output).toContain('✓ tool.called(shell)');
    const assertionsLine = output
      .split('\n')
      .find(
        (line) => line.includes('assertions') && line.includes('2 of 2 passed'),
      );
    expect(assertionsLine).toBeDefined();
    expect(assertionsLine).not.toContain('1.2s');
  });

  it('lists configured CLI mocks and ordered calls in verbose mode', () => {
    const jobs = [makeJob({cliMockNames: ['vitest', 'vercel']})];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [
        makeResult(jobs[0]!, {
          cliMockCalls: [
            {
              executable: 'vitest',
              argv: ['run'],
              cwd: '/tmp/work',
              timestamp: 1,
              exitCode: 1,
              stdout: '',
              stderr: 'failed',
            },
            {
              executable: 'vitest',
              argv: ['run'],
              cwd: '/tmp/work',
              timestamp: 2,
              exitCode: 0,
              stdout: 'passed',
              stderr: '',
            },
          ],
        }),
      ],
      ctx: createRenderContext({mode: 'verbose'}),
    });

    expect(output).toContain('cli mocks: vitest, vercel');
    expect(output).toContain('cli mock: vitest run -> exit 1');
    expect(output).toContain('cli mock: vitest run -> exit 0');
  });

  it('quotes unsafe CLI mock arguments and bounds the rendered call width', () => {
    const jobs = [
      makeJob({cliMockNames: ['vitest', 'bad\n\u001b[31m\u009b2J']}),
    ];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results: [
        makeResult(jobs[0]!, {
          cliMockCalls: [
            {
              executable: 'vitest',
              argv: ['hello world', 'line\n\u001b[31m', 'x'.repeat(100)],
              cwd: '/tmp/work',
              timestamp: 1,
              exitCode: 0,
              stdout: '',
              stderr: '',
            },
          ],
        }),
      ],
      ctx: createRenderContext({mode: 'verbose', terminalWidth: 72}),
    });
    const callLine = output
      .split('\n')
      .find((line) => line.includes('cli mock:'));

    expect(callLine).toContain('vitest "hello world" "line\\n\\u001b[31m"');
    expect(callLine).not.toContain('\u001b');
    expect(output).not.toContain('\u009b');
    expect(output).toContain('bad\\n\\u001b[31m\\u009b2J');
    expect(callLine).toHaveLength(72);
    expect(callLine).toContain('...');
    expect(callLine?.endsWith(' -> exit 0')).toBe(true);
  });

  it('expands every iteration in verbose multi-iteration mode', () => {
    const jobs = [makeJob({iteration: 0}), makeJob({iteration: 1})];
    const results = [
      makeResult(jobs[0]!),
      makeResult(jobs[1]!, {
        status: 'assertion_failed',
        failedAssertionIndexes: [0],
      }),
    ];
    const output = renderGroupedRun({
      dynos: [dynoOf(jobs)],
      results,
      ctx: createRenderContext({mode: 'verbose'}),
    });

    expect(output).toContain('✗ 1/2 failed   .F');
    expect(output).toContain('iter 1 ✓ 2 assertions');
    expect(output).toContain('iter 2 ✗ 1 of 2 failed');
    expect(output).toContain('✗ tool.called(shell)');
    // Passing iterations expand too: one phase block per iteration.
    expect(output.match(/setup {6}0 commands/g)).toHaveLength(2);
  });
});

describe('renderRunSummary', () => {
  it('leads with job counts and labels assertion detail', () => {
    const jobs = [
      makeJob({assertionCount: 3}),
      makeJob({scenarioId: 'scenario.b', assertionCount: 2}),
    ];
    const results = jobs.map((job) => makeResult(job));

    const summary = renderRunSummary(results, ctx);

    expect(summary).toContain('✓ 2 jobs passed · 5 assertions');
  });

  it('uses the failed fraction when assertion failures exist', () => {
    const jobs = [makeJob(), makeJob({scenarioId: 'scenario.b'})];
    const results = [
      makeResult(jobs[0]!),
      makeResult(jobs[1]!, {
        status: 'assertion_failed',
        failedAssertionIndexes: [0],
      }),
    ];

    const summary = renderRunSummary(results, ctx);

    expect(summary).toContain('✗ 1 of 2 jobs failed · 1 failed assertion');
    expect(summary).not.toContain('0 ');
  });

  it('counts job errors separately from assertion failures', () => {
    const jobs = [makeJob(), makeJob({scenarioId: 'scenario.b'})];
    const results = [
      makeResult(jobs[0]!),
      makeResult(jobs[1]!, {status: 'harness_failed'}),
    ];

    const summary = renderRunSummary(results, ctx);

    expect(summary).toContain('✗ 1 of 2 jobs failed · ✗ 1 job error');
    expect(summary).not.toContain('failed assertion');
  });

  it('labels zero-assertion runs explicitly', () => {
    const jobs = [makeJob({assertionCount: 0})];
    const results = jobs.map((job) => makeResult(job));

    const summary = renderRunSummary(results, ctx);

    expect(summary).toContain('✓ 1 job passed · no assertions');
  });

  it('formats durations of a minute or more as minutes and seconds', () => {
    const jobs = [makeJob()];
    const results = [makeResult(jobs[0]!, {totalMs: 62_000})];

    const summary = renderRunSummary(results, ctx);

    expect(summary).toContain('1m02s');
  });
});
