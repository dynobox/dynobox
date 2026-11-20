import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * A fresh Dynobox-owned temporary directory. Harness cleanup, such as
 * Antigravity's project records, recognizes the `dynobox-job-` prefix.
 */
export async function createWorkDir(
  scratchRoot: string | undefined,
  label = '',
): Promise<string> {
  return mkdtemp(join(scratchRoot ?? tmpdir(), `dynobox-job-${label}`));
}
