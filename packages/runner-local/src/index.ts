import type {IrScenario} from '@dynobox/sdk';

export type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
} from './harnesses/index.js';
export {FakeHarness} from './harnesses/index.js';
export type {SetupCommandResult, SetupResult} from './setup.js';
export {runSetup} from './setup.js';

export type LocalRunnerJob = {
  id: string;
  scenario: IrScenario;
  iteration: number;
};

export type LocalRunnerResult = {
  jobId: string;
  scenarioId: string;
  iteration: number;
};

export async function runJob(job: LocalRunnerJob): Promise<LocalRunnerResult> {
  throw new Error(`runner-local runJob is not implemented yet: ${job.id}`);
}
