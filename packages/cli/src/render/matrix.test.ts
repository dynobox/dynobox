import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {GREEN, RED, RESET} from '../terminal/ansi.js';
import {createRenderContext} from '../terminal/index.js';
import {renderPassRateMatrix} from './matrix.js';

describe('renderPassRateMatrix', () => {
  it('renders plain sparkline cells by scenario and harness', () => {
    const jobs = [
      job('scenario.commit', 'commit skill', 'claude-code', 0),
      job('scenario.commit', 'commit skill', 'claude-code', 1),
      job('scenario.commit', 'commit skill', 'codex', 0),
    ];
    const results = [
      result(jobs[0]!, true),
      result(jobs[1]!, false),
      result(jobs[2]!, false),
    ];

    const output = renderPassRateMatrix(
      jobs,
      results,
      createRenderContext({color: false}),
    );

    expect(output).toContain('pass-rate matrix');
    expect(output).toContain('scenario');
    expect(output).toContain('claude-code');
    expect(output).toContain('codex');
    expect(output).toContain('commit skill  .F');
    expect(output).toContain('F');
  });

  it('aligns each sparkline start with its harness header', () => {
    const jobs = [
      job('scenario.commit', 'commit skill', 'claude-code', 0),
      job('scenario.commit', 'commit skill', 'claude-code', 1),
      job('scenario.commit', 'commit skill', 'codex', 0),
      job('scenario.commit', 'commit skill', 'codex', 1),
    ];
    const results = [
      result(jobs[0]!, true),
      result(jobs[1]!, false),
      result(jobs[2]!, false),
      result(jobs[3]!, true),
    ];

    const output = renderPassRateMatrix(
      jobs,
      results,
      createRenderContext({color: false}),
    );
    const lines = output.split('\n');
    const header = lines.find((line) => line.includes('claude-code'))!;
    const row = lines.find((line) => line.includes('commit skill'))!;

    expect(row.indexOf('.F')).toBe(header.indexOf('claude-code'));
    expect(row.indexOf('F.')).toBe(header.indexOf('codex'));
  });

  it('renders every iteration mark instead of truncating failures', () => {
    const jobs = Array.from({length: 11}, (_, iteration) =>
      job('scenario.commit', 'commit skill', 'claude-code', iteration),
    );
    const results = jobs.map((job, index) => result(job, index !== 10));

    const output = renderPassRateMatrix(
      jobs,
      results,
      createRenderContext({color: false}),
    );

    expect(output).toContain('..........F');
  });

  it('colors individual sparkline marks when color is enabled', () => {
    const jobs = [
      job('scenario.commit', 'commit skill', 'claude-code', 0),
      job('scenario.commit', 'commit skill', 'claude-code', 1),
    ];
    const results = [result(jobs[0]!, true), result(jobs[1]!, false)];

    const output = renderPassRateMatrix(
      jobs,
      results,
      createRenderContext({color: true}),
    );

    expect(output).toContain(`${GREEN}.${RESET}`);
    expect(output).toContain(`${RED}F${RESET}`);
  });
});

function job(
  scenarioId: string,
  scenarioName: string,
  harness: 'claude-code' | 'codex',
  iteration: number,
): LocalRunnerJob {
  return {
    id: `${scenarioId}.${harness}.iteration.${iteration}`,
    scenario: {
      id: scenarioId,
      name: scenarioName,
      prompt: 'p',
      harnesses: [{id: harness}],
      setup: [],
      fixtures: [],
      endpoints: [],
      assertions: [],
    },
    harness,
    iteration,
  };
}

function result(job: LocalRunnerJob, passed: boolean): LocalRunnerResult {
  return {
    jobId: job.id,
    scenarioId: job.scenario.id,
    harness: job.harness,
    iteration: job.iteration,
    status: passed ? 'passed' : 'assertion_failed',
    passed,
    workDir: '/tmp/dynobox',
    setupResult: {success: true, logs: []},
    httpEvents: [],
    artifacts: [],
    assertionResults: [],
    diagnostics: [],
    warnings: [],
    timing: {setupMs: 0, harnessMs: 0, assertionsMs: 0, totalMs: 0},
  };
}
