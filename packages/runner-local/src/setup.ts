import {cp} from 'node:fs/promises';

import type {IrScenario} from '@dynobox/sdk/ir';
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

export type RunFixturesOptions = {
  fixtures: readonly string[];
  workDir: string;
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

/** Execute the setup commands attached to a compiled scenario. */
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

/**
 * Recursively mirrors each fixtures directory into the scenario work dir.
 * Each source directory is copied verbatim — nested structure is preserved.
 * Stops at the first failure, mirroring `runSetup` semantics.
 */
export async function runFixtures(
  opts: RunFixturesOptions,
): Promise<SetupResult> {
  const logs: SetupCommandLog[] = [];
  for (const src of opts.fixtures) {
    const command = `fixtures:${src}`;
    const startedAt = process.hrtime.bigint();
    try {
      await cp(src, opts.workDir, {
        recursive: true,
        dereference: false,
        errorOnExist: false,
        force: true,
      });
      logs.push({
        command,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: hrtimeMs(startedAt),
      });
    } catch (error) {
      logs.push({
        command,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: hrtimeMs(startedAt),
      });
      return {success: false, logs};
    }
  }
  return {success: true, logs};
}

/** Mirror fixtures attached to a compiled scenario. */
export async function runScenarioFixtures(opts: {
  scenario: Pick<IrScenario, 'fixtures'>;
  workDir: string;
}): Promise<SetupResult> {
  return runFixtures({
    fixtures: opts.scenario.fixtures,
    workDir: opts.workDir,
  });
}

function hrtimeMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
