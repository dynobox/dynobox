import type {IrScenario} from '@dynobox/sdk';
import {execaCommand} from 'execa';

export type SetupCommandLog = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type SetupResult = {
  success: boolean;
  /** Per-command output, in execution order. Stops at the first failure. */
  logs: SetupCommandLog[];
};

export type RunSetupOptions = {
  commands: readonly string[];
  workDir: string;
  env?: Record<string, string>;
};

/**
 * Executes author-provided setup commands sequentially as shell strings.
 * Dynobox-owned values are passed through cwd/env instead of interpolated.
 */
export async function runSetup(opts: RunSetupOptions): Promise<SetupResult> {
  const logs: SetupCommandLog[] = [];
  const env =
    opts.env === undefined ? process.env : {...process.env, ...opts.env};

  for (const command of opts.commands) {
    const result = await execaCommand(command, {
      cwd: opts.workDir,
      env,
      reject: false,
      shell: true,
    });
    const exitCode = result.exitCode ?? 1;

    logs.push({
      command,
      exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      durationMs: result.durationMs,
    });

    if (exitCode !== 0) return {success: false, logs};
  }

  return {success: true, logs};
}

export async function runScenarioSetup(opts: {
  scenario: Pick<IrScenario, 'setup'>;
  workDir: string;
  env?: Record<string, string>;
}): Promise<SetupResult> {
  const setupOptions: RunSetupOptions = {
    commands: opts.scenario.setup,
    workDir: opts.workDir,
  };
  if (opts.env !== undefined) setupOptions.env = opts.env;
  return runSetup(setupOptions);
}
