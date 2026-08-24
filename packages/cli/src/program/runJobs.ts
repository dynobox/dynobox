import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';

import type {RunDynoGroup} from '../render/index.js';

export type IndexedJob = {
  job: LocalRunnerJob;
  index: number;
};

export type HarnessLane = {
  jobs: IndexedJob[];
};

export type ScenarioExecution = {
  dyno: RunDynoGroup;
  name: string;
  jobs: IndexedJob[];
  harnessLanes: HarnessLane[];
};

export type RunExecutionHooks = {
  scenarioStarted?: (scenario: ScenarioExecution) => void;
  jobStarted?: (entry: IndexedJob, scenario: ScenarioExecution) => void;
  jobCompleted?: (
    entry: IndexedJob,
    result: LocalRunnerResult,
    scenario: ScenarioExecution,
  ) => void;
  scenarioCompleted?: (
    scenario: ScenarioExecution,
    results: readonly LocalRunnerResult[],
  ) => void;
};

export type RunExecutionResult = {
  results: LocalRunnerResult[];
  elapsedMs: number;
};

/**
 * Build the execution shape without changing canonical job order. Dynos and
 * scenarios remain sequential; effective harness configurations become lanes.
 */
export function buildScenarioExecutions(
  dynos: readonly RunDynoGroup[],
): ScenarioExecution[] {
  const executions: ScenarioExecution[] = [];
  let jobIndex = 0;

  for (const dyno of dynos) {
    const scenarioById = new Map<string, ScenarioExecution>();
    for (const job of dyno.jobs) {
      const entry = {job, index: jobIndex};
      jobIndex += 1;

      let scenario = scenarioById.get(job.scenario.id);
      if (scenario === undefined) {
        scenario = {
          dyno,
          name: job.scenario.name,
          jobs: [],
          harnessLanes: [],
        };
        scenarioById.set(job.scenario.id, scenario);
        executions.push(scenario);
      }
      scenario.jobs.push(entry);

      const key = harnessLaneKey(job);
      let lane = scenario.harnessLanes.find(
        (candidate) => harnessLaneKey(candidate.jobs[0]!.job) === key,
      );
      if (lane === undefined) {
        lane = {jobs: []};
        scenario.harnessLanes.push(lane);
      }
      lane.jobs.push(entry);
    }
  }

  return executions;
}

/**
 * Execute each scenario in order. Harness lanes within a scenario overlap,
 * while iterations and duplicate jobs within one lane remain sequential.
 */
export async function runScenarioExecutions(
  dynos: readonly RunDynoGroup[],
  execute: (job: LocalRunnerJob) => Promise<LocalRunnerResult>,
  hooks: RunExecutionHooks = {},
): Promise<RunExecutionResult> {
  const startedAt = Date.now();
  const executions = buildScenarioExecutions(dynos);
  const resultSlots: Array<LocalRunnerResult | undefined> = Array.from({
    length: dynos.reduce((total, dyno) => total + dyno.jobs.length, 0),
  });

  for (const scenario of executions) {
    hooks.scenarioStarted?.(scenario);
    const laneOutcomes = await Promise.allSettled(
      scenario.harnessLanes.map(async (lane) => {
        for (const entry of lane.jobs) {
          hooks.jobStarted?.(entry, scenario);
          const result = await execute(entry.job);
          resultSlots[entry.index] = result;
          hooks.jobCompleted?.(entry, result, scenario);
        }
      }),
    );
    const rejected = laneOutcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    if (rejected !== undefined) throw rejected.reason;

    const scenarioResults = scenario.jobs.map((entry) => {
      const result = resultSlots[entry.index];
      if (result === undefined) {
        throw new Error(`Missing runner result for job ${entry.job.id}`);
      }
      return result;
    });
    hooks.scenarioCompleted?.(scenario, scenarioResults);
  }

  const results = resultSlots.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Missing runner result at plan index ${index}`);
    }
    return result;
  });
  return {results, elapsedMs: Math.max(0, Date.now() - startedAt)};
}

function harnessLaneKey(
  job: Pick<LocalRunnerJob, 'harness' | 'model' | 'permissionMode'>,
): string {
  return `${job.harness}\0${job.model ?? ''}\0${job.permissionMode ?? ''}`;
}
