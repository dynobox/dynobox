import type {AssertionResult, HttpEvent} from '@dynobox/evaluators';
import type {HarnessId, PermissionMode} from '@dynobox/sdk';
import type {IrScenario} from '@dynobox/sdk/ir';

import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './harnesses/index.js';
import type {SetupResult} from './setup.js';

/** One compiled scenario/harness/iteration unit scheduled by the CLI. */
export type LocalRunnerJob = {
  id: string;
  scenario: IrScenario;
  harness: HarnessId;
  model?: string;
  permissionMode?: PermissionMode;
  iteration: number;
};

/** Progress events emitted while `runJob` advances through setup/harness/assertions. */
export type RunJobProgressEvent =
  | {
      type: 'fixtures.started';
      job: LocalRunnerJob;
      fixturesCount: number;
    }
  | {
      type: 'fixtures.completed';
      job: LocalRunnerJob;
      fixturesResult: SetupResult;
    }
  | {
      type: 'setup.started';
      job: LocalRunnerJob;
      commandCount: number;
    }
  | {
      type: 'setup.completed';
      job: LocalRunnerJob;
      setupResult: SetupResult;
    }
  | {
      type: 'harness.started';
      job: LocalRunnerJob;
      harnessId: string;
    }
  | {
      type: 'harness.completed';
      job: LocalRunnerJob;
      harnessId: string;
      success: boolean;
      toolCount: number;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: 'harness.tool';
      job: LocalRunnerJob;
      harnessId: string;
      toolEvent: ToolEvent;
      toolCount: number;
    }
  | {
      type: 'assertions.started';
      job: LocalRunnerJob;
      assertionCount: number;
    }
  | {
      type: 'assertions.completed';
      job: LocalRunnerJob;
      assertionResults: AssertionResult[];
    };

/** Runtime options for local execution of one job. */
export type RunJobOptions = {
  harnesses?: readonly Harness[];
  scratchRoot?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onProgress?: (event: RunJobProgressEvent) => void;
};

export type LocalRunnerStatus =
  | 'passed'
  | 'setup_failed'
  | 'harness_failed'
  | 'assertion_failed';

/** Artifact produced by local execution and surfaced in debug output. */
export type LocalArtifact = {
  kind: 'work_dir';
  path: string;
};

/** Timing breakdown for setup, harness execution, and assertions. */
export type LocalRunnerTiming = {
  setupMs: number;
  harnessMs: number;
  assertionsMs: number;
  totalMs: number;
};

export type LocalRunnerWarning = {
  kind: 'permission_denied';
  message: string;
  tool?: {
    kind: string;
    rawName: string;
    command?: string;
  };
};

/** Structured result returned by `runJob` for rendering and summaries. */
export type LocalRunnerResult = {
  jobId: string;
  scenarioId: string;
  harness: HarnessId;
  model?: string;
  harnessVersion: string | null;
  permissionMode?: PermissionMode;
  iteration: number;
  status: LocalRunnerStatus;
  passed: boolean;
  workDir: string;
  setupResult: SetupResult;
  harnessOutput?: HarnessRunOutput;
  harnessResult?: HarnessResult;
  httpEvents: readonly HttpEvent[];
  artifacts: LocalArtifact[];
  assertionResults: AssertionResult[];
  diagnostics: string[];
  warnings: LocalRunnerWarning[];
  timing: LocalRunnerTiming;
};
