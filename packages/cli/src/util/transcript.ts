/**
 * Side-effect helper extracted from debug rendering: write a job's harness
 * transcript to disk and return the path.
 */

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

const TRANSCRIPT_FILENAME = 'dynobox-transcript.log';

/**
 * Write `transcript` to `<workDir>/dynobox-transcript.log`. Returns the
 * absolute path written so callers can render it.
 */
export function writeTranscriptLog(
  workDir: string,
  transcript: string,
): string {
  const path = join(workDir, TRANSCRIPT_FILENAME);
  writeFileSync(path, transcript);
  return path;
}
