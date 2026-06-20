import type {VerifyCommandResult} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk/ir';
import {execaCommand} from 'execa';

export type RunVerifyCommandsOptions = {
  scenario: Pick<IrScenario, 'assertions'>;
  workDir: string;
  env?: Record<string, string>;
};

/** Execute post-harness verification commands in authored assertion order. */
export async function runVerifyCommands(
  opts: RunVerifyCommandsOptions,
): Promise<VerifyCommandResult[]> {
  const env =
    opts.env === undefined ? process.env : {...process.env, ...opts.env};
  const results: VerifyCommandResult[] = [];

  for (const assertion of verifyCommandAssertions(opts.scenario.assertions)) {
    const result = await execaCommand(assertion.command, {
      cwd: opts.workDir,
      env,
      reject: false,
      shell: true,
    });

    results.push({
      assertionId: assertion.id,
      command: assertion.command,
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      durationMs: result.durationMs,
    });
  }

  return results;
}

type RunnableVerifyCommandAssertion = {
  id: string;
  kind: 'verify.command';
  command: string;
};

function verifyCommandAssertions(
  assertions: IrScenario['assertions'],
): RunnableVerifyCommandAssertion[] {
  return assertions.filter(
    (assertion): assertion is RunnableVerifyCommandAssertion =>
      assertion.kind === 'verify.command',
  );
}
