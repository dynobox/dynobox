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
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          type: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      diagnostics: [],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    } as unknown as LocalRunnerResult;

    const records = renderJsonRunOutput({jobs: [job], results: [result]})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const jobRecord = records[0] as {
      assertions: Array<Record<string, unknown>>;
      harness: Record<string, unknown>;
    };

    expect(jobRecord.harness).toMatchObject({version: '2.1.4'});
    expect(jobRecord.assertions[0]).toMatchObject({
      assertionId: 'assertion.labels.reads-package',
      label: 'reads package.json',
      type: 'tool.called',
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
      artifacts: [],
      assertionResults: [],
      diagnostics: [],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
    })) as unknown as LocalRunnerResult[];

    const records = renderJsonRunOutput({jobs, results})
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records.at(-1)).toMatchObject({
      type: 'summary',
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
