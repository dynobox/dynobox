/**
 * Debug-mode detail block: work directory, artifact paths, and (optionally)
 * the path to a transcript log.
 *
 * Pure: callers are responsible for actually writing the transcript file
 * (see `util/transcript.ts`) and passing the resulting path in.
 */

import type {LocalRunnerResult} from '@dynobox/runner-local';

import {dim, type RenderContext} from '../terminal/index.js';
import type {DebugLogPaths} from '../util/transcript.js';

export function renderDebugDetails(
  result: LocalRunnerResult,
  ctx: RenderContext,
  options: {debugLogPaths?: DebugLogPaths} = {},
): string {
  const lines = [`        ${dim(ctx, `work dir  ${result.workDir}`)}\n`];
  for (const artifact of result.artifacts) {
    lines.push(
      `        ${dim(ctx, `artifact  ${artifact.kind} ${artifact.path}`)}\n`,
    );
  }
  for (const [label, path] of debugLogEntries(options.debugLogPaths)) {
    lines.push(`        ${dim(ctx, `log       ${label} ${path}`)}\n`);
  }
  return lines.join('');
}

function debugLogEntries(
  paths: DebugLogPaths | undefined,
): Array<[string, string]> {
  if (paths === undefined) return [];
  return [
    ['transcript', paths.transcript],
    ['chat_jsonl', paths.chatHistory],
    ['stderr', paths.stderr],
    ['tool_events', paths.toolEvents],
    ['cli_mocks', paths.cliMocks],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
}
