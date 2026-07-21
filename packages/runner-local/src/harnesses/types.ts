import type {
  HarnessId,
  PermissionMode,
  ToolEvent as SdkToolEvent,
} from '@dynobox/sdk';

export type {ShellToolEvent, ToolEvent, ToolKind} from '@dynobox/sdk';

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
  /** Optional permission/sandbox mode for the harness invocation. */
  permissionMode?: PermissionMode;
  /** Optional live callback for tool events observed while the harness runs. */
  onToolEvent?: (event: SdkToolEvent) => void;
};

/** Raw output from a harness invocation, before any extraction. */
export type HarnessRunOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Harness-specific invocation metadata used during result extraction. */
  metadata?: Record<string, unknown>;
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
  toolEvents: SdkToolEvent[];
  /** Structured harness error text when the process output exposes one. */
  errorMessage?: string;
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

  /** Best-effort installed executable version for run provenance. */
  version?(): Promise<string | null>;

  /** Launch the agent and return raw output. */
  run(input: HarnessInput): Promise<HarnessRunOutput>;

  /** Parse raw invocation output into a structured result. */
  extractResult(raw: HarnessRunOutput): HarnessResult;
}
