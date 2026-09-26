import {constants} from 'node:fs';
import {access, realpath} from 'node:fs/promises';
import {delimiter, resolve} from 'node:path';

import {McpHarnessError} from './mcpError.js';

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
      return {executable: await realpath(candidate), workDir};
    } catch {
      // Continue searching the original PATH.
    }
  }
  throw new McpHarnessError(
    'configuration_failed',
    `Could not find the "${executable}" executable on PATH.`,
  );
}
