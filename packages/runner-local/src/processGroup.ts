import type {ChildProcess} from 'node:child_process';

/** Stop an owned POSIX process group when cancellation occurs. */
export function cancelProcessGroupOnAbort(
  subprocess: Pick<ChildProcess, 'pid'>,
  signal?: AbortSignal,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopGroup = (killSignal: NodeJS.Signals) => {
    if (process.platform === 'win32' || subprocess.pid === undefined) return;
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
  return () => {
    signal?.removeEventListener('abort', cancel);
    clearTimeout(timer);
    // Also stop children that closed their output pipes before the parent exited.
    if (signal?.aborted) stopGroup('SIGKILL');
  };
}
