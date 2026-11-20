import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {renderJsonRunOutput} from './jsonReporter.js';

describe('renderJsonRunOutput', () => {
  it('includes assertion labels when present in the compiled scenario', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.labels',
        name: 'labels',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        cliMocks: {},
        endpoints: [],
        assertions: [
          {
            id: 'assertion.labels.reads-package',
            label: 'reads package.json',
            type: 'tool.called',
            tool: 'shell',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      harnessVersion: '2.1.4',
      iteration: 0,
      status: 'passed',
      passed: true,
      workDir: '/tmp/work',
      setupResult: {success: true, logs: []},
      httpEvents: [],
      harnessCliMockCallCount: 1,
      cliMockCalls: [
        {
          executable: 'vitest',
          argv: ['run'],
          cwd: '/tmp/work',
          timestamp: 1,
          exitCode: 0,
          stdout: 'passed',
          stderr: '',
        },
        {
          executable: 'vitest',
          argv: ['verify'],
          cwd: '/tmp/work',
          timestamp: 2,
          exitCode: 0,
          stdout: 'verified',
          stderr: '',
        },
      ],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          type: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      verificationFailed: false,
      diagnostics: [],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    } satisfies LocalRunnerResult;

    const records = renderJsonRunOutput({jobs: [job], results: [result]})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const jobRecord = records[0] as {
      assertions: Array<Record<string, unknown>>;
      harness: Record<string, unknown>;
      observations: Record<string, unknown>;
    };

    expect(jobRecord.harness).toMatchObject({version: '2.1.4'});
    expect(jobRecord.observations).toMatchObject({
      cliMockCallCount: 2,
      harnessCliMockCallCount: 1,
    });
    expect(jobRecord.assertions[0]).toMatchObject({
      assertionId: 'assertion.labels.reads-package',
      label: 'reads package.json',
      type: 'tool.called',
    });
  });

  it('reports conversation turns under the v4 schema', () => {
    const job = {
      id: 'job.turns',
      scenario: {
        id: 'scenario.turns',
        name: 'turns',
        prompt: 'Add a users table.',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        cliMocks: {},
        user: {replies: ['UUIDs.']},
        endpoints: [],
        assertions: [],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      harnessVersion: null,
      iteration: 0,
      status: 'passed',
      passed: true,
      workDir: '/tmp/work',
      setupResult: {success: true, logs: []},
      httpEvents: [],
      harnessCliMockCallCount: 0,
      cliMockCalls: [],
      artifacts: [],
      assertionResults: [],
      verificationFailed: false,
      diagnostics: [],
      warnings: [],
      turns: [
        {
          prompt: 'Add a users table.',
          finalMessage: 'Key type?',
          durationMs: 5,
        },
        {prompt: 'UUIDs.', durationMs: 7},
      ],
      timing: {setupMs: 0, harnessMs: 12, assertionsMs: 0, totalMs: 12},
    } satisfies LocalRunnerResult;

    const [jobRecord] = renderJsonRunOutput({jobs: [job], results: [result]})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(jobRecord).toMatchObject({
      schema: 'dynobox.report.v4',
      turns: [
        {
          prompt: 'Add a users table.',
          finalMessage: 'Key type?',
          durationMs: 5,
        },
        {prompt: 'UUIDs.', finalMessage: null, durationMs: 7},
      ],
    });
  });

  it('includes only selected anyOf branch indexes in assertion output', () => {
    const job = {
      id: 'job.anyof',
      scenario: {
        id: 'scenario.anyof',
        name: 'anyOf',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        cliMocks: {},
        endpoints: [],
        assertions: [],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'assertion_failed',
      passed: false,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      cliMockCalls: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.anyof.passed',
          type: 'anyOf',
          passed: true,
          message: 'Matched anyOf branch #1.',
          evidence: {kind: 'anyOf', branchIndex: 1, branches: []},
        },
        {
          assertionId: 'assertion.anyof.failed',
          type: 'anyOf',
          passed: false,
          message: 'No anyOf branch matched.',
          evidence: {kind: 'anyOf', branches: []},
        },
      ],
      diagnostics: [],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    } as unknown as LocalRunnerResult;

    const [record] = renderJsonRunOutput({jobs: [job], results: [result]})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const assertions = (record as {assertions: Array<Record<string, unknown>>})
      .assertions;

    expect(assertions[0]).toMatchObject({matchedBranchIndex: 1});
    expect(assertions[1]).not.toHaveProperty('matchedBranchIndex');
  });

  it('includes aggregate matrix cells in the summary record', () => {
    const jobs = [0, 1].map(
      (iteration) =>
        ({
          id: `scenario.labels.claude-code.iteration.${iteration}`,
          scenario: {
            id: 'scenario.labels',
            name: 'labels',
            prompt: 'p',
            harnesses: [{id: 'claude-code'}],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            assertions: [],
          },
          harness: 'claude-code',
          iteration,
        }) satisfies LocalRunnerJob,
    );
    const results = jobs.map((job, index) => ({
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: job.iteration,
      status: index === 0 ? 'passed' : 'assertion_failed',
      passed: index === 0,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      cliMockCalls: [],
      artifacts: [],
      assertionResults: [],
      diagnostics: [],
      warnings: [],
      timing: {
        setupMs: 0,
        harnessMs: 0,
        assertionsMs: 0,
        totalMs: (index + 1) * 100,
      },
    })) as unknown as LocalRunnerResult[];

    const records = renderJsonRunOutput({jobs, results, elapsedMs: 50})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records.at(-1)).toMatchObject({
      type: 'summary',
      totals: {durationMs: 300, elapsedMs: 50},
      matrix: {
        scenarios: [{id: 'scenario.labels', name: 'labels'}],
        harnesses: [{id: 'claude-code'}],
        iterations: [1, 2],
        cells: [
          {
            scenarioId: 'scenario.labels',
            scenarioName: 'labels',
            passed: 1,
            failed: 1,
            total: 2,
            failedJobs: ['scenario.labels.claude-code.iteration.1'],
          },
        ],
      },
    });
  });
});
