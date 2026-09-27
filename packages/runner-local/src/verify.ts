import type {VerifyCommandResult} from '@dynobox/evaluators';
import {collectVerifyCommandAssertions} from '@dynobox/evaluators';
import type {IrScenario} from '@dynobox/sdk/ir';
import {execaCommand} from 'execa';

export type RunVerifyCommandsOptions = {
  scenario: Pick<IrScenario, 'assertions'>;
  workDir: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Execute post-harness verification commands in authored order, including
 * nested `verify.command` branches inside anyOf assertions.
 */
export async function runVerifyCommands(
  opts: RunVerifyCommandsOptions,
): Promise<VerifyCommandResult[]> {
  const env =
    opts.env === undefined ? process.env : {...process.env, ...opts.env};
  const results: VerifyCommandResult[] = [];

  for (const assertion of collectVerifyCommandAssertions(
    opts.scenario.assertions,
  )) {
    if (opts.signal?.aborted) break;
    const result = await execaCommand(assertion.command, {
      cwd: opts.workDir,
      env,
      reject: false,
      shell: true,
      ...(opts.signal === undefined
        ? {}
        : {cancelSignal: opts.signal, forceKillAfterDelay: 1000}),
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
