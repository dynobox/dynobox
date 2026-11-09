import {lineSplitter} from '../harnesses/runStreamingHarness.js';
import type {HarnessRunOutput} from '../harnesses/types.js';
import {startOwnedProcess} from '../processGroup.js';
import {McpHarnessError} from './errors.js';

export function mcpProcessOutput(
  result: {exitCode?: number; stdout: string; stderr: string},
  durationMs: number,
): HarnessRunOutput {
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
}

/** Bound native version probes and preserve their raw output on validation failure. */
export async function probeMcpVersion(
  executable: string,
  options: Parameters<typeof startOwnedProcess>[2],
  remaining: () => number,
  validate: (probe: Awaited<ReturnType<typeof startOwnedProcess>>) => string,
): Promise<string> {
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...options,
    stdin: 'ignore',
    timeout: Math.min(5000, remaining()),
  });
  try {
    remaining();
    return validate(probe);
  } catch (error) {
    if (error instanceof McpHarnessError)
      throw new McpHarnessError(
        error.category,
        error.message,
        mcpProcessOutput(probe, probe.durationMs),
      );
    throw error;
  }
}

/** Collect native JSONL output, retaining the first stream failure for the adapter. */
export async function collectMcpProcess(
  child: ReturnType<typeof startOwnedProcess>,
  options: {
    label: string;
    onLine(line: string): void;
    describeError?(error: unknown): string;
  },
) {
  let failure: McpHarnessError | undefined;
  const lines = lineSplitter((line) => {
    if (!line.trim() || failure) return;
    try {
      options.onLine(line);
    } catch (error) {
      failure =
        error instanceof McpHarnessError
          ? error
          : new McpHarnessError(
              'execution_failed',
              options.describeError?.(error) ??
                // Parser messages can quote output, so keep them out of reports.
                (error instanceof SyntaxError ||
                (error instanceof Error && error.cause instanceof SyntaxError)
                  ? `${options.label} emitted unparseable JSON output.`
                  : `${options.label} event processing failed: ${error instanceof Error ? error.message : String(error)}`),
            );
      child.stop();
    }
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => lines.write(chunk));
  const result = await child;
  // A timed-out process leaves a truncated line; report the timeout, not a parse error.
  if (!result.timedOut) lines.flush();
  return {result, failure};
}
