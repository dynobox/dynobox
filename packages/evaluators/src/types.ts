import type {ToolEvent} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

export type {ToolEvent} from '@dynobox/sdk';

/** Canonical HTTP event shape consumed by HTTP assertion evaluators. */
export type HttpEvent = {
  endpointId: string | null;
  method: string;
  url: string;
  host: string;
  timestamp: string;
  status?: number;
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

/**
 * Post-setup baseline for `artifact.unchanged`. Raw bytes are retained only
 * for successful regular-file snapshots and never rendered in diagnostics.
 */
export type ArtifactBaseline =
  | {
      kind: 'file';
      path: string;
      size: number;
      bytes: Uint8Array;
    }
  | {
      kind: 'missing';
      path: string;
    }
  | {
      kind: 'not-file';
      path: string;
      fileType: 'directory' | 'symlink' | 'other';
    }
  | {
      kind: 'unreadable';
      path: string;
      message: string;
    }
  | {
      kind: 'invalid';
      message: string;
    };

/** Snapshot/final path state without raw file contents. */
export type ArtifactPathState =
  | {kind: 'file'; path: string; size: number}
  | {kind: 'missing'; path: string}
  | {
      kind: 'not-file';
      path: string;
      fileType: 'directory' | 'symlink' | 'other';
    }
  | {kind: 'unreadable'; path: string; message: string}
  | {kind: 'invalid'; message: string};

/** Diagnostic evidence for `artifact.unchanged` without raw file contents. */
export type ArtifactUnchangedEvidence = {
  kind: 'unchanged';
  path: string;
  baseline?: ArtifactPathState;
  final?: ArtifactPathState;
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
  /** Baselines keyed by assertion id, including nested anyOf branch ids. */
  artifactBaselines?: ReadonlyMap<string, ArtifactBaseline> | undefined;
  /**
   * Pre-evaluated non-verification `anyOf` branches keyed by anyOf assertion
   * id. Entries are undefined for verification branches deferred until after
   * verify commands run.
   */
  anyOfObservationBranches?:
    | ReadonlyMap<string, readonly (AssertionResult | undefined)[]>
    | undefined;
};

/** Result for one compiled assertion. */
export type AssertionResult = {
  assertionId: string;
  type: string;
  passed: boolean;
  message: string;
  evidence?: unknown;
};
