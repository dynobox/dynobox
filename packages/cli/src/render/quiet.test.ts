import type {
  LocalRunnerJob,
  LocalRunnerResult,
  LocalRunnerStatus,
} from '@dynobox/runner-local';
import type {HarnessId} from '@dynobox/sdk';
import {describe, expect, it} from 'vitest';

import {createRenderContext} from '../terminal/index.js';
import type {RunDynoGroup} from './plan.js';
import {renderQuietRun} from './quiet.js';

const ctx = createRenderContext();

type JobSpec = {
  scenarioId?: string;
  scenarioName?: string;
  harness?: HarnessId;
  iteration?: number;
  assertionCount?: number;
  assertionTool?: 'shell' | 'edit_file';
};

function makeJob(spec: JobSpec = {}): LocalRunnerJob {
  const scenarioId = spec.scenarioId ?? 'scenario.test';
  const harness = spec.harness ?? 'claude-code';
  const iteration = spec.iteration ?? 0;
  const assertionCount = spec.assertionCount ?? 2;
  return {
    id: `${scenarioId}.${harness}.iteration.${iteration}`,
    scenario: {
      id: scenarioId,
      name: spec.scenarioName ?? 'test scenario',
      prompt: 'Run a test.',
      harnesses: [{id: harness}],
      setup: [],
      fixtures: [],
      cliMocks: {},
      endpoints: [],
      assertions: Array.from({length: assertionCount}, (_, index) => ({
        id: `${scenarioId}.assert.${index}`,
        type: 'tool.called' as const,
        tool: spec.assertionTool ?? 'shell',
      })),
    },
    harness,
    iteration,
  };
}

type ResultSpec = {
  status?: LocalRunnerStatus;
  failedAssertionIndexes?: number[];
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
    cliMockCalls: [],
    artifacts: [],
    assertionResults,
    diagnostics:
      status === 'harness_failed' ? ['codex exited with code 1'] : [],
    warnings: [],
    timing: {
      setupMs: 0,
      harnessMs: 0,
      assertionsMs: 0,
      totalMs: 4200,
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

describe('renderQuietRun', () => {
  it('prints progress marks and a job-led summary for passing runs', () => {
    const jobs = [makeJob(), makeJob({scenarioId: 'scenario.b'})];
    const output = renderQuietRun(
      [dynoOf(jobs)],
      jobs.map((job) => makeResult(job)),
      ctx,
    );

    expect(output).toContain('..\n');
    expect(output).toContain('2 jobs passed, 4 assertions');
  });

  it('lists failed assertion labels under FAIL groups', () => {
    const jobs = [makeJob()];
    const output = renderQuietRun(
      [dynoOf(jobs)],
      [
        makeResult(jobs[0]!, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
      ],
      ctx,
    );

    expect(output).toContain('FAIL  package-script-check / test scenario');
    expect(output).toContain('tool.called(shell)');
    expect(output).toContain('1 of 1 jobs failed, 1 failed assertion');
  });

  it('uses assertion definitions from the failed dyno when assertion ids collide', () => {
    const jobA = makeJob({assertionTool: 'shell'});
    const jobB = makeJob({assertionTool: 'edit_file'});
    const output = renderQuietRun(
      [
        dynoOf([jobA]),
        dynoOf([jobB], {name: 'other-dyno', path: 'other.dyno.ts'}),
      ],
      [
        makeResult(jobA, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
        makeResult(jobB),
      ],
      ctx,
    );

    expect(output).toContain('tool.called(shell)');
    expect(output).not.toContain('tool.called(edit_file)');
  });

  it('reports setup and harness job errors', () => {
    const jobs = [makeJob()];
    const setupOutput = renderQuietRun(
      [dynoOf(jobs)],
      [makeResult(jobs[0]!, {status: 'setup_failed'})],
      ctx,
    );
    const harnessOutput = renderQuietRun(
      [dynoOf(jobs)],
      [makeResult(jobs[0]!, {status: 'harness_failed'})],
      ctx,
    );

    expect(setupOutput).toContain('setup failed');
    expect(setupOutput).toContain('1 of 1 jobs failed, 1 job error');
    expect(setupOutput).not.toContain('jobs passed');

    expect(harnessOutput).toContain('harness failed');
    expect(harnessOutput).toContain('codex exited with code 1');
    expect(harnessOutput).toContain('1 of 1 jobs failed, 1 job error');
    expect(harnessOutput).not.toContain('jobs passed');
  });

  it('shows harness diagnostics before assertion labels when both are present', () => {
    const job = makeJob();
    const result: LocalRunnerResult = {
      ...makeResult(job, {status: 'harness_failed'}),
      assertionResults: [
        {
          assertionId: job.scenario.assertions[0]!.id,
          type: 'tool.called',
          passed: false,
          message: 'not matched',
        },
      ],
      harnessResult: {
        exitCode: 1,
        durationMs: 100,
        transcript: 'failed',
        finalMessage: 'failed',
        toolEvents: [],
      },
    };
    const output = renderQuietRun([dynoOf([job])], [result], ctx);

    const harnessIndex = output.indexOf('harness failed');
    const diagnosticIndex = output.indexOf('codex exited with code 1');
    const assertionIndex = output.indexOf('tool.called(shell)');
    expect(harnessIndex).toBeGreaterThan(-1);
    expect(diagnosticIndex).toBeGreaterThan(harnessIndex);
    expect(assertionIndex).toBeGreaterThan(diagnosticIndex);
  });

  it('does not prefix single-iteration groups when another group has iterations', () => {
    const singleJob = makeJob({
      scenarioId: 'scenario.single',
      scenarioName: 'single scenario',
    });
    const multiJobs = [
      makeJob({
        scenarioId: 'scenario.multi',
        scenarioName: 'multi scenario',
        iteration: 0,
      }),
      makeJob({
        scenarioId: 'scenario.multi',
        scenarioName: 'multi scenario',
        iteration: 1,
      }),
    ];
    const output = renderQuietRun(
      [dynoOf([singleJob, ...multiJobs])],
      [
        makeResult(singleJob, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
        makeResult(multiJobs[0]!),
        makeResult(multiJobs[1]!, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
      ],
      ctx,
    );

    const singleFailIndex = output.indexOf(
      'FAIL  package-script-check / single scenario',
    );
    const multiFailIndex = output.indexOf(
      'FAIL  package-script-check / multi scenario',
    );
    const singleDetail = output.slice(
      singleFailIndex,
      multiFailIndex > singleFailIndex ? multiFailIndex : undefined,
    );
    const multiDetail = output.slice(multiFailIndex);

    expect(singleDetail).toContain('tool.called(shell)');
    expect(singleDetail).not.toContain('iter 1 ');
    expect(multiDetail).toContain('iter 2 tool.called(shell)');
  });

  it('prefixes failed iterations with iter labels', () => {
    const jobs = [makeJob({iteration: 0}), makeJob({iteration: 1})];
    const output = renderQuietRun(
      [dynoOf(jobs)],
      [
        makeResult(jobs[0]!),
        makeResult(jobs[1]!, {
          status: 'assertion_failed',
          failedAssertionIndexes: [0],
        }),
      ],
      ctx,
    );

    expect(output).toContain('.F\n');
    expect(output).toContain('iter 2 tool.called(shell)');
  });

  it('lists warnings without a FAIL group when jobs pass', () => {
    const job = makeJob();
    const result = {
      ...makeResult(job),
      warnings: [
        {
          kind: 'permission_denied' as const,
          message: 'blocked by policy',
          tool: {kind: 'shell', rawName: 'Bash', command: 'rm -rf /'},
        },
      ],
    };
    const output = renderQuietRun([dynoOf([job])], [result], ctx);

    expect(output).not.toContain('FAIL  ');
    expect(output).toContain('WARN  package-script-check / test scenario');
    expect(output).toContain('permission denied for shell command: rm -rf /');
  });
});
