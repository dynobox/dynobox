import {execaCommand} from 'execa';

/** Run a shell command and stop its process group when cancellation occurs. */
export async function runShellCommand(options: {
  command: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const {signal} = options;
  const ownsProcessGroup = process.platform !== 'win32';
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopGroup = (killSignal: NodeJS.Signals) => {
    if (!ownsProcessGroup || subprocess.pid === undefined) return;
    try {
      process.kill(-subprocess.pid, killSignal);
    } catch {
      // The process group can exit before the cancellation handler runs.
    }
  };
  const cancel = () => {
    stopGroup('SIGTERM');
    timer ??= setTimeout(() => stopGroup('SIGKILL'), 1000);
  };
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) cancel();
  try {
    return await subprocess;
  } finally {
    signal?.removeEventListener('abort', cancel);
    clearTimeout(timer);
    // Also stop children that closed their output pipes before the shell exited.
    if (signal?.aborted) stopGroup('SIGKILL');
  }
}
