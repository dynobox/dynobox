import {exec as execCb} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execCb);

export type SetupCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type SetupResult = {
  success: boolean;
  /** Per-command output, in execution order. Stops at the first failure. */
  commands: SetupCommandResult[];
};

/**
 * Executes setup commands sequentially in a shell. Stops at the first
 * non-zero exit code.
 */
export async function runSetup(opts: {
  commands: string[];
  workDir: string;
  env: Record<string, string>;
}): Promise<SetupResult> {
  const results: SetupCommandResult[] = [];

  for (const command of opts.commands) {
    const start = performance.now();
    try {
      const {stdout, stderr} = await exec(command, {
        cwd: opts.workDir,
        env: opts.env,
      });
      results.push({
        command,
        exitCode: 0,
        stdout,
        stderr,
        durationMs: performance.now() - start,
      });
    } catch (err: unknown) {
      const e = err as {code?: unknown; stdout?: string; stderr?: string};
      results.push({
        command,
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        durationMs: performance.now() - start,
      });
      return {success: false, commands: results};
    }
  }

  return {success: true, commands: results};
}
