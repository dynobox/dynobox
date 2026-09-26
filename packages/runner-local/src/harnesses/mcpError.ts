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
      throw new McpHarnessError(
        'timed_out',
        `MCP run exceeded its ${timeoutMs}ms timeout.`,
      );
    return remaining;
  };
}
