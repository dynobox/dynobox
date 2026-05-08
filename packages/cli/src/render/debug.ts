/**
 * Debug-mode detail block: work directory, artifact paths, and (optionally)
 * the path to a transcript log.
 *
 * Pure: callers are responsible for actually writing the transcript file
 * (see `util/transcript.ts`) and passing the resulting path in.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {dim, type RenderContext} from '../terminal/index.js';

export function renderDebugDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
  options: {transcriptLogPath?: string} = {},
): string {
  const lines = [`        ${dim(ctx, `work dir  ${result.workDir}`)}\n`];
  for (const artifact of result.artifacts) {
    lines.push(
      `        ${dim(ctx, `artifact  ${artifact.kind} ${artifact.path}`)}\n`,
    );
  }
  if (options.transcriptLogPath !== undefined) {
    lines.push(
      `        ${dim(ctx, `log       ${options.transcriptLogPath}`)}\n`,
    );
  }
  return lines.join('');
}
