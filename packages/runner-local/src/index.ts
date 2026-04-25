import type {IrScenario} from '@dynobox/sdk';

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
