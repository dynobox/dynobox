/**
 * Side-effect helpers extracted from debug rendering: write a job's harness
 * debug logs to disk and return the paths.
 */

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalRunnerResult} from '@dynobox/runner-local';

const TRANSCRIPT_FILENAME = 'dynobox-transcript.log';
const CHAT_HISTORY_FILENAME = 'dynobox-chat-history.jsonl';
const STDERR_FILENAME = 'dynobox-stderr.log';
const TOOL_EVENTS_FILENAME = 'dynobox-tool-events.json';

export type DebugLogPaths = {
  transcript?: string;
  chatHistory?: string;
  stderr?: string;
  toolEvents?: string;
};

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

export function writeDebugLogs(result: LocalRunnerResult): DebugLogPaths {
  const paths: DebugLogPaths = {};

  const transcript = result.harnessResult?.transcript;
  if (transcript !== undefined && transcript.length > 0) {
    paths.transcript = writeTranscriptLog(result.workDir, transcript);
  }

  const stdout = result.harnessOutput?.stdout;
  if (stdout !== undefined && stdout.length > 0) {
    paths.chatHistory = writeLog(result.workDir, CHAT_HISTORY_FILENAME, stdout);
  }

  const stderr = result.harnessOutput?.stderr;
  if (stderr !== undefined && stderr.length > 0) {
    paths.stderr = writeLog(result.workDir, STDERR_FILENAME, stderr);
  }

  const toolEvents = result.harnessResult?.toolEvents;
  if (toolEvents !== undefined) {
    paths.toolEvents = writeLog(
      result.workDir,
      TOOL_EVENTS_FILENAME,
      `${JSON.stringify(toolEvents, null, 2)}\n`,
    );
  }

  return paths;
}

export function hasDebugLogPaths(paths: DebugLogPaths): boolean {
  return Object.values(paths).some((path) => path !== undefined);
}

function writeLog(workDir: string, filename: string, contents: string): string {
  const path = join(workDir, filename);
  writeFileSync(path, contents);
  return path;
}
