import type {ToolKind} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

/** Canonical HTTP event shape consumed by HTTP assertion evaluators. */
export type HttpEvent = {
  endpointId: string | null;
  method: string;
  url: string;
  host: string;
  timestamp: string;
  status?: number;
};

/** Canonical tool event shape consumed by assertion evaluators. */
export type ToolEvent = {
  kind: ToolKind;
  rawName: string;
  input: unknown;
  command?: string;
  status?: 'success' | 'failure';
  message?: string;
  startedAt?: string;
  completedAt?: string;
};

/** Captured output from a post-harness verification command. */
export type VerifyCommandResult = {
  assertionId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/** Inputs available when evaluating one scenario's compiled assertions. */
export type EvaluationInput = {
  assertions: readonly IrAssertion[];
  toolEvents: readonly ToolEvent[];
  httpEvents?: readonly HttpEvent[] | undefined;
  verifyCommandResults?: readonly VerifyCommandResult[] | undefined;
  workDir?: string | undefined;
  transcript?: string | undefined;
  finalMessage?: string | undefined;
};

/** Result for one compiled assertion. */
export type AssertionResult = {
  assertionId: string;
  kind: string;
  passed: boolean;
  message: string;
  evidence?: unknown;
};
