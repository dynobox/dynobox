import type {HarnessId} from '@dynobox/sdk';

/** Configuration and environment passed to a harness invocation. */
export type HarnessInput = {
  /** The scenario prompt to send to the agent. */
  prompt: string;
  /** Working directory for the harness process. */
  workDir: string;
  /** Environment variables (proxy settings, API keys, etc.). */
  env: Record<string, string>;
  /** Optional invocation timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional harness-specific model name or alias. */
  model?: string;
  /** Optional live callback for tool events observed while the harness runs. */
  onToolEvent?: (event: ToolEvent) => void;
};

/** Raw output from a harness invocation, before any extraction. */
export type HarnessRunOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type ToolKind =
  | 'shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_files'
  | 'web_fetch'
  | 'web_search'
  | 'mcp'
  | 'task'
  | 'unknown';

export type ToolEvent = {
  kind: ToolKind;
  rawName: string;
  input: unknown;
  status?: 'success' | 'failure';
  startedAt?: string;
  completedAt?: string;
};

export type ShellToolEvent = ToolEvent & {
  kind: 'shell';
  command: string;
};

/** Structured result after extracting transcript and final message. */
export type HarnessResult = {
  exitCode: number;
  durationMs: number;
  /** Full agent transcript (stdout or PTY capture). */
  transcript: string;
  /** The final assistant message, if extractable. */
  finalMessage: string | undefined;
  /** Canonicalized harness tool events observed during the run. */
  toolEvents: ToolEvent[];
};

/**
 * A harness drives an agent CLI (Claude Code, Codex, etc.).
 *
 * Invocation (`run`) is separated from result extraction
 * (`extractResult`) so the orchestrator can store raw output as a debug
 * artifact before parsing, and each adapter can implement its own
 * extraction logic.
 */
export interface Harness {
  readonly id: HarnessId;

  /** Launch the agent and return raw output. */
  run(input: HarnessInput): Promise<HarnessRunOutput>;

  /** Parse raw invocation output into a structured result. */
  extractResult(raw: HarnessRunOutput): HarnessResult;
}
