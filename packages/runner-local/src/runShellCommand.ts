import {execaCommand} from 'execa';

import {cancelProcessGroupOnAbort} from './processGroup.js';

/** Run a shell command and stop its process group when cancellation occurs. */
export async function runShellCommand(options: {
  command: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const {signal} = options;
  // execa still spawns when already cancelled, and a fast command can finish
  // before the kill lands.
  if (signal?.aborted)
    return {exitCode: 1, stdout: '', stderr: '', durationMs: 0};
  const ownsProcessGroup = signal !== undefined && process.platform !== 'win32';
  const subprocess = execaCommand(options.command, {
    cwd: options.workDir,
    env: options.env,
    reject: false,
    shell: true,
    detached: ownsProcessGroup,
    ...(signal === undefined
      ? {}
      : {cancelSignal: signal, forceKillAfterDelay: 1000}),
  });
  const cleanup = cancelProcessGroupOnAbort(subprocess, signal);
  try {
    return await subprocess;
  } finally {
    cleanup();
  }
}
