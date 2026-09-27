import {constants} from 'node:fs';
import {access, realpath} from 'node:fs/promises';
import {delimiter, resolve} from 'node:path';

import {McpHarnessError} from './mcpError.js';
import type {
  HarnessInput,
  McpHarnessRun,
  McpServerConnections,
  PreparedMcpHarness,
} from './types.js';

/**
 * Pin the installed harness before CLI mocks change PATH for the job, so a
 * mocked command can never stand in for the harness itself.
 */
export async function resolveMcpExecutable(
  executable: string,
  input: {workDir: string; env: Readonly<Record<string, string>>},
): Promise<{executable: string; workDir: string}> {
  const workDir = await realpath(input.workDir);
  const candidates =
    executable.includes('/') || executable.includes('\\')
      ? [resolve(workDir, executable)]
      : (input.env.PATH ?? process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => resolve(workDir, directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      // Keep symlinks: multicall shims (Volta, mise) dispatch on argv[0].
      return {executable: candidate, workDir};
    } catch {
      // Continue searching the original PATH.
    }
  }
  throw new McpHarnessError(
    'configuration_failed',
    `Could not find the "${executable}" executable on PATH.`,
  );
}

export type McpRunner = (options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}) => Promise<McpHarnessRun>;

/** Shared `prepareMcp` body: pin the executable and work dir, then bind. */
export async function prepareMcpHarness(
  executable: string,
  extraArgs: readonly string[],
  input: Pick<HarnessInput, 'workDir' | 'env'>,
  runner: McpRunner,
): Promise<PreparedMcpHarness> {
  const resolved = await resolveMcpExecutable(executable, input);
  const args = [...extraArgs];
  return {
    run: (runInput, servers) =>
      runner({
        executable: resolved.executable,
        input: {...runInput, workDir: resolved.workDir},
        servers,
        extraArgs: args,
      }),
  };
}
