import {isAtLeastVersion, parseVersion} from './version.js';

export type McpHarnessFailure =
  | 'configuration_failed'
  | 'unsupported_version'
  | 'not_ready'
  | 'execution_failed'
  | 'timed_out'
  | 'cleanup_failed';

/** Adapter failure with a category for reports and a human-readable reason. */
export class McpHarnessError extends Error {
  constructor(
    readonly category: McpHarnessFailure,
    message: string,
  ) {
    super(message);
    this.name = 'McpHarnessError';
  }
}

// Largest delay timers accept; stands in for "no deadline".
const NO_DEADLINE_MS = 2 ** 31 - 1;

/**
 * Remaining time helper shared by MCP adapters. Like ordinary jobs, there is
 * no deadline unless `timeoutMs` is set. Throws `timed_out` once a deadline
 * passes and `execution_failed` when the run was cancelled.
 */
export function mcpDeadline(
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): () => number {
  const deadline = Date.now() + (timeoutMs ?? NO_DEADLINE_MS);
  return () => {
    if (signal?.aborted)
      throw new McpHarnessError('execution_failed', 'MCP run was cancelled.');
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      // Adapters get the job's remaining budget, not the configured
      // timeout, so the message names no number.
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    return remaining;
  };
}

/** Stop waiting for preparation when its budget expires or the job is cancelled. */
export async function awaitMcpPreparation<T>(
  prepare: () => Promise<T>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal!.reason);
      signal?.addEventListener('abort', cancel, {once: true});
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            reject(
              new McpHarnessError('timed_out', 'MCP run exceeded its timeout.'),
            ),
          timeoutMs,
        );
      }
    });
    return await Promise.race([prepare(), interrupted]);
  } finally {
    clearTimeout(timer);
    if (cancel !== undefined) signal?.removeEventListener('abort', cancel);
  }
}

/** Return the probed version, or fail when it is below the adapter minimum. */
export function requireMcpVersion(
  label: string,
  minVersion: string,
  probe: {failed: boolean; stdout: string},
  parse: (stdout: string) => string | null = parseVersion,
): string {
  const version = probe.failed ? null : parse(probe.stdout);
  if (version === null || !isAtLeastVersion(version, minVersion))
    throw new McpHarnessError(
      'unsupported_version',
      `${label} MCP mocking requires ${minVersion} or newer (found ${version ?? 'unknown'}).`,
    );
  return version;
}
