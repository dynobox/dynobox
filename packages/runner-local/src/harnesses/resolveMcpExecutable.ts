import {constants} from 'node:fs';
import {access, realpath} from 'node:fs/promises';
import {delimiter, resolve} from 'node:path';

/**
 * Pin the installed harness before CLI mocks change PATH for the job.
 * Return undefined when no executable on the caller's original PATH is usable.
 */
export async function resolveMcpExecutable(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const candidates =
    executable.includes('/') || executable.includes('\\')
      ? [resolve(cwd, executable)]
      : (env.PATH ?? process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => resolve(cwd, directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue searching the original PATH.
    }
  }
  return undefined;
}
