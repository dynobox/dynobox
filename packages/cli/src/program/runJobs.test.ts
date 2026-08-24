import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import type {IrScenario} from '@dynobox/sdk/ir';
import {describe, expect, it, vi} from 'vitest';

import type {RunDynoGroup} from '../render/index.js';
import {buildScenarioExecutions, runScenarioExecutions} from './runJobs.js';

describe('runScenarioExecutions', () => {
  it('runs harness configurations concurrently and lane jobs sequentially', async () => {
    const first = scenario('first');
    const second = scenario('second');
    const jobs = [
      job(first, 'claude-code', 0),
      job(first, 'claude-code', 1),
      job(first, 'codex', 0),
      job(first, 'codex', 1),
      job(second, 'claude-code', 0),
      job(second, 'codex', 0),
    ];
    const gates = new Map(jobs.map((entry) => [entry.id, deferred()]));
    const starts: string[] = [];
    const run = runScenarioExecutions([dyno(jobs)], async (entry) => {
      starts.push(entry.id);
      await gates.get(entry.id)!.promise;
      return result(entry);
    });

    await vi.waitFor(() => expect(starts).toEqual([jobs[0]!.id, jobs[2]!.id]));
    gates.get(jobs[0]!.id)!.resolve();
    await vi.waitFor(() => expect(starts).toContain(jobs[1]!.id));
    expect(starts).not.toContain(jobs[3]!.id);

    gates.get(jobs[2]!.id)!.resolve();
    await vi.waitFor(() => expect(starts).toContain(jobs[3]!.id));
    gates.get(jobs[1]!.id)!.resolve();
    expect(starts).not.toContain(jobs[4]!.id);

    gates.get(jobs[3]!.id)!.resolve();
    await vi.waitFor(() => {
      expect(starts).toContain(jobs[4]!.id);
      expect(starts).toContain(jobs[5]!.id);
    });
    gates.get(jobs[4]!.id)!.resolve();
    gates.get(jobs[5]!.id)!.resolve();

    await expect(run).resolves.toMatchObject({
      results: jobs.map((entry) => ({jobId: entry.id})),
    });
  });

  it('gives different models of the same harness separate lanes', () => {
    const testScenario = scenario('models');
    const executions = buildScenarioExecutions([
      dyno([
        job(testScenario, 'codex', 0, 'gpt-5.5'),
        job(testScenario, 'codex', 1, 'gpt-5.5'),
        job(testScenario, 'codex', 0, 'gpt-5.6'),
      ]),
    ]);

    expect(executions).toHaveLength(1);
    expect(executions[0]!.harnessLanes.map((lane) => lane.jobs.length)).toEqual(
      [2, 1],
    );
  });

  it('waits for sibling lanes to settle before propagating an exception', async () => {
    const testScenario = scenario('failure');
    const claude = job(testScenario, 'claude-code', 0);
    const codex = job(testScenario, 'codex', 0);
    const codexGate = deferred();
    let rejected = false;
    const run = runScenarioExecutions(
      [dyno([claude, codex])],
      async (entry) => {
        if (entry === claude) throw new Error('unexpected runner error');
        await codexGate.promise;
        return result(entry);
      },
    );
    void run.catch(() => {
      rejected = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(false);
    codexGate.resolve();
    await expect(run).rejects.toThrow('unexpected runner error');
  });
});

function scenario(id: string): IrScenario {
  return {
    id: `scenario.${id}`,
    name: id,
    prompt: `Run ${id}.`,
    harnesses: [],
    setup: [],
    fixtures: [],
    cliMocks: {},
    endpoints: [],
    assertions: [],
  };
}

function job(
  testScenario: IrScenario,
  harness: LocalRunnerJob['harness'],
  iteration: number,
  model?: string,
): LocalRunnerJob {
  return {
    id: `${testScenario.id}.${harness}.${model ?? 'default'}.${iteration}`,
    scenario: testScenario,
    harness,
    ...(model === undefined ? {} : {model}),
    iteration,
  };
}

function dyno(jobs: LocalRunnerJob[]): RunDynoGroup {
  return {path: 'test.dyno.ts', jobs};
}

function result(entry: LocalRunnerJob): LocalRunnerResult {
  return {
    jobId: entry.id,
    scenarioId: entry.scenario.id,
    harness: entry.harness,
    iteration: entry.iteration,
  } as LocalRunnerResult;
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}
