import type {ChildProcess} from 'node:child_process';

import {execa, type ResultPromise} from 'execa';

type OwnedProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  extendEnv?: boolean;
  reject?: boolean;
  stdin?: 'ignore';
  input?: string;
  timeout?: number;
  cancelSignal?: AbortSignal;
  forceKillAfterDelay?: number;
};
type OwnedLaunchOptions = OwnedProcessOptions & {
  detached: boolean;
  forceKillAfterDelay: number;
};

/** Start an owned process and stop its descendants before waiting on their pipes. */
export function startOwnedProcess(
  executable: string,
  args: readonly string[],
  options: OwnedProcessOptions,
): ResultPromise<OwnedLaunchOptions> & {stop(): void} {
  const child = execa<OwnedLaunchOptions>(executable, args, {
    ...options,
    detached: process.platform !== 'win32',
    forceKillAfterDelay: 1000,
  });
  const abort = new AbortController();
  const cleanupGroup = cancelProcessGroupOnAbort(child, abort.signal);
  const stop = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    child.kill();
  };
  const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
  options.cancelSignal?.addEventListener('abort', stop, {once: true});
  if (options.cancelSignal?.aborted) stop();
  // Descendants can hold stdout/stderr open after the parent exits. Waiting
  // for the complete execa result before stopping them would deadlock.
  child.once('exit', stop);
  const cleanup = () => {
    clearTimeout(timer);
    options.cancelSignal?.removeEventListener('abort', stop);
    child.removeListener('exit', stop);
    stop();
    cleanupGroup();
  };
  void child.then(cleanup, cleanup);
  // Execa's optional error fields conflict with exactOptionalPropertyTypes.
  return Object.assign(child, {stop}) as ResultPromise<OwnedLaunchOptions> & {
    stop(): void;
  };
}

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
