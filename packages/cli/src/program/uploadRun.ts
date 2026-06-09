import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  RunUploadV1,
  type RunUploadJobV1,
  type RunUploadV1 as RunUploadPayloadV1,
} from '@dynobox/run-schema';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {assertionByIdForJobs} from '../jobs.js';
import {readPackageVersion} from '../util/version.js';
import {resolveAuthToken, type AuthEnvironment} from './auth.js';
import {resolveApiUrl} from './identityApi.js';

const execFileAsync = promisify(execFile);
const RUN_UPLOAD_TIMEOUT_MS = 10_000;

export type UploadRunInput = {
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  runFailed: boolean;
  target: string;
  env?: AuthEnvironment;
  writeStderr: (value: string) => void;
};

export async function uploadRun(input: UploadRunInput): Promise<void> {
  const token = resolveAuthToken(
    input.env === undefined ? {} : {env: input.env},
  );
  if (token === null) {
    input.writeStderr(
      'warning: run was not saved; no Dynobox token found. Run `dynobox login` or set DYNOBOX_TOKEN.\n',
    );
    return;
  }

  const payload = buildRunUploadPayload({
    jobs: input.jobs,
    results: input.results,
    runFailed: input.runFailed,
    target: input.target,
    gitHash: await collectGitHash(),
  });
  const payloadResult = RunUploadV1.safeParse(payload);
  if (!payloadResult.success) {
    input.writeStderr(
      `warning: could not save run; generated payload failed validation (${payloadResult.error.issues[0]?.path.join('.') || 'payload'}).\n`,
    );
    return;
  }

  try {
    const response = await fetch(`${resolveApiUrl(input.env)}/runs`, {
      body: JSON.stringify(payloadResult.data),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(RUN_UPLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      input.writeStderr(
        `warning: could not save run; API returned HTTP ${response.status}.\n`,
      );
      return;
    }

    const body = await response.json().catch(() => null);
    const url = readResponseUrl(body);
    input.writeStderr(url === null ? 'Saved run.\n' : `Saved run: ${url}\n`);
  } catch {
    input.writeStderr('warning: could not save run; upload request failed.\n');
  }
}

export function buildRunUploadPayload(input: {
  jobs: readonly LocalRunnerJob[];
  results: readonly LocalRunnerResult[];
  runFailed?: boolean;
  target: string;
  gitHash: string | null;
}): RunUploadPayloadV1 {
  const assertionById = assertionByIdForJobs(input.jobs);
  const jobs = input.results.map((result, index) => {
    const job = input.jobs[index] ?? jobFromResult(result);
    return buildRunUploadJob(job, result, assertionById);
  });
  const failed = jobs.filter((job) => !job.passed).length;
  const warnings = jobs.reduce((count, job) => count + job.warnings.length, 0);

  return {
    schemaVersion: RUN_UPLOAD_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    cliVersion: readPackageVersion(),
    gitHash: input.gitHash,
    target: truncate(input.target, RUN_UPLOAD_LIMITS.targetLength),
    status: input.runFailed === true || failed > 0 ? 'failed' : 'passed',
    totals: {
      jobs: jobs.length,
      passed: jobs.length - failed,
      failed,
      warnings,
      durationMs: durationMs(
        input.results.reduce(
          (total, result) => total + result.timing.totalMs,
          0,
        ),
      ),
    },
    jobs,
  };
}

export async function collectGitHash(): Promise<string | null> {
  try {
    const {stdout} = await execFileAsync('git', ['rev-parse', 'HEAD']);
    const hash = stdout.trim();
    return hash.length === 0
      ? null
      : truncate(hash, RUN_UPLOAD_LIMITS.gitHashLength);
  } catch {
    return null;
  }
}

function buildRunUploadJob(
  job: LocalRunnerJob,
  result: LocalRunnerResult,
  assertionById: ReadonlyMap<string, IrAssertion>,
): RunUploadJobV1 {
  return {
    jobId: truncate(result.jobId, RUN_UPLOAD_LIMITS.scenarioIdLength),
    scenario: {
      id: truncate(job.scenario.id, RUN_UPLOAD_LIMITS.scenarioIdLength),
      name: truncate(job.scenario.name, RUN_UPLOAD_LIMITS.scenarioNameLength),
    },
    harness: {
      id: truncate(result.harness, RUN_UPLOAD_LIMITS.harnessIdLength),
      model:
        result.model === undefined
          ? null
          : truncate(result.model, RUN_UPLOAD_LIMITS.modelLength),
    },
    iteration: result.iteration + 1,
    status: result.status,
    passed: result.passed,
    durationMs: durationMs(result.timing.totalMs),
    assertions: result.assertionResults.map((assertion) => {
      const source = assertionById.get(assertion.assertionId);
      return {
        assertionId: truncate(
          assertion.assertionId,
          RUN_UPLOAD_LIMITS.assertionIdLength,
        ),
        label: truncate(
          source?.label ?? source?.kind ?? assertion.kind,
          RUN_UPLOAD_LIMITS.assertionLabelLength,
        ),
        kind: truncate(assertion.kind, RUN_UPLOAD_LIMITS.assertionKindLength),
        passed: assertion.passed,
        message: truncate(
          assertion.message,
          RUN_UPLOAD_LIMITS.assertionMessageLength,
        ),
      };
    }),
    diagnostics: diagnosticsForStatus(result.status),
    warnings: result.warnings
      .slice(0, RUN_UPLOAD_LIMITS.warningsPerJob)
      .map((warning) =>
        truncate(warning.message, RUN_UPLOAD_LIMITS.warningLength),
      ),
  };
}

function diagnosticsForStatus(status: LocalRunnerResult['status']): string[] {
  if (status === 'setup_failed') return ['Setup failed.'];
  if (status === 'harness_failed') return ['Harness failed.'];
  return [];
}

function durationMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function jobFromResult(result: LocalRunnerResult): LocalRunnerJob {
  return {
    id: result.jobId,
    scenario: {
      id: result.scenarioId,
      name: result.scenarioId,
      prompt: result.scenarioId,
      harnesses: [
        {
          id: result.harness,
          ...(result.model === undefined ? {} : {model: result.model}),
          ...(result.permissionMode === undefined
            ? {}
            : {permissionMode: result.permissionMode}),
        },
      ],
      setup: [],
      fixtures: [],
      endpoints: [],
      assertions: [],
    },
    harness: result.harness,
    ...(result.model === undefined ? {} : {model: result.model}),
    ...(result.permissionMode === undefined
      ? {}
      : {permissionMode: result.permissionMode}),
    iteration: result.iteration,
  };
}

function readResponseUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('url' in body)) {
    return null;
  }
  const url = body.url;
  return typeof url === 'string' && url.trim().length > 0 ? url : null;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
