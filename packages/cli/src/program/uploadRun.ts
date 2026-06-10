import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import type {
  HttpEvent,
  LocalRunnerJob,
  LocalRunnerResult,
  ToolEvent,
} from '@dynobox/runner-local';
import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  RunUploadV1,
  type RunUploadAssertionDefinitionV1,
  type RunUploadAssertionDisplayChildV1,
  type RunUploadAssertionDisplayV1,
  type RunUploadAssertionEvidenceV1,
  type RunUploadAssertionV1,
  type RunUploadJobV1,
  type RunUploadV1 as RunUploadPayloadV1,
} from '@dynobox/run-schema';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {assertionByIdForJobs} from '../jobs.js';
import {
  describeAssertion,
  describeExpectation,
  describeToolEvent,
} from '../render/describe.js';
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
      return compactAssertion({
        assertionId: assertion.assertionId,
        kind: assertion.kind,
        message: assertion.message,
        passed: assertion.passed,
        result,
        source,
      });
    }),
    diagnostics: diagnosticsForStatus(result.status),
    warnings: result.warnings
      .slice(0, RUN_UPLOAD_LIMITS.warningsPerJob)
      .map((warning) =>
        truncate(warning.message, RUN_UPLOAD_LIMITS.warningLength),
      ),
  };
}

function compactAssertion(input: {
  assertionId: string;
  kind: string;
  message: string;
  passed: boolean;
  result: LocalRunnerResult;
  source: IrAssertion | undefined;
}): RunUploadAssertionV1 {
  return {
    assertionId: truncate(
      input.assertionId,
      RUN_UPLOAD_LIMITS.assertionIdLength,
    ),
    label: truncate(
      assertionLabel(input.source, input.kind),
      RUN_UPLOAD_LIMITS.assertionLabelLength,
    ),
    kind: truncate(input.kind, RUN_UPLOAD_LIMITS.assertionKindLength),
    passed: input.passed,
    message: truncate(input.message, RUN_UPLOAD_LIMITS.assertionMessageLength),
    ...(input.source === undefined
      ? {}
      : {
          definition: assertionDefinition(input.source),
          display: assertionDisplay(input.source, input.result, input.message),
        }),
    evidence: assertionEvidence(input.result, input.assertionId),
  };
}

function assertionLabel(
  assertion: IrAssertion | undefined,
  fallbackKind: string,
): string {
  if (assertion === undefined) return fallbackKind;
  const description = describeAssertion(assertion);
  return assertion.label === undefined
    ? description
    : `${assertion.label}  ${description}`;
}

function assertionDefinition(
  assertion: IrAssertion,
): RunUploadAssertionDefinitionV1 {
  const base = {kind: assertion.kind};
  if (assertion.kind === 'tool.called' || assertion.kind === 'tool.notCalled') {
    return {
      ...base,
      toolKind: assertion.toolKind,
      ...matcherDefinition(assertion),
      ...pathMatcherDefinition(assertion),
    };
  }
  if (assertion.kind === 'sequence.inOrder') {
    return {
      ...base,
      steps: assertion.steps.map((step) => ({
        kind: step.kind,
        toolKind: step.toolKind,
        ...matcherDefinition(step),
        ...pathMatcherDefinition(step),
      })),
    };
  }
  if (assertion.kind === 'http.called') {
    return {
      ...base,
      endpointId: assertion.endpointId,
      ...(assertion.status === undefined ? {} : {status: assertion.status}),
    };
  }
  if (assertion.kind === 'http.notCalled') {
    return {...base, endpointId: assertion.endpointId};
  }
  if (assertion.kind === 'skill.invoked') {
    return {...base, skill: assertion.skill};
  }
  if (assertion.kind === 'artifact.exists') {
    return {...base, path: truncateDetail(assertion.path)};
  }
  if (assertion.kind === 'artifact.contains') {
    return {
      ...base,
      path: truncateDetail(assertion.path),
      text: truncateDetail(assertion.text),
    };
  }
  if (
    assertion.kind === 'transcript.contains' ||
    assertion.kind === 'finalMessage.contains'
  ) {
    return {...base, text: truncateDetail(assertion.text)};
  }
  return base;
}

function assertionDisplay(
  assertion: IrAssertion,
  result: LocalRunnerResult,
  fallbackObserved: string,
): RunUploadAssertionDisplayV1 {
  const evidence = assertionResultEvidence(result, assertion.id);
  return {
    title: truncateDetail(assertionLabel(assertion, assertion.kind)),
    expectation: truncateDetail(describeExpectation(assertion)),
    observed: truncateNullableDetail(
      observedAssertionSummary(assertion, result, fallbackObserved),
    ),
    children:
      assertion.kind === 'sequence.inOrder'
        ? sequenceChildren(assertion, evidence)
        : [],
  };
}

function sequenceChildren(
  assertion: Extract<IrAssertion, {kind: 'sequence.inOrder'}>,
  evidence: unknown,
): RunUploadAssertionDisplayChildV1[] {
  const matchedCount = Array.isArray(evidence) ? evidence.length : undefined;
  return assertion.steps.map((step, index) => {
    const passed =
      matchedCount === undefined
        ? null
        : index < matchedCount
          ? true
          : index === matchedCount
            ? false
            : null;
    return {
      index: index + 1,
      kind: step.kind,
      title: truncateDetail(describeToolStep(step)),
      expectation: truncateDetail(describeToolStepExpectation(step)),
      observed: null,
      passed,
    };
  });
}

function assertionEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): RunUploadAssertionEvidenceV1 {
  const evidence = assertionResultEvidence(result, assertionId);
  const matches = evidenceMatches(evidence);
  return {
    observedCount:
      (result.harnessResult?.toolEvents.length ?? 0) + result.httpEvents.length,
    ...(matches.length === 0 ? {} : {matchedCount: matches.length}),
    observedKinds: observedKinds(result),
    ...(matches.length === 0 ? {} : {matches}),
  };
}

function assertionResultEvidence(
  result: LocalRunnerResult,
  assertionId: string,
): unknown {
  return result.assertionResults.find(
    (candidate) => candidate.assertionId === assertionId,
  )?.evidence;
}

function evidenceMatches(evidence: unknown): string[] {
  const values = Array.isArray(evidence) ? evidence : [evidence];
  return values.flatMap((value) => {
    if (isToolEvent(value)) return [truncateDetail(describeToolEvent(value))];
    if (isHttpEvent(value)) return [truncateDetail(formatHttpEvent(value))];
    return [];
  });
}

function observedKinds(result: LocalRunnerResult): string[] {
  return [
    ...new Set([
      ...(result.harnessResult?.toolEvents.map((event) => event.kind) ?? []),
      ...result.httpEvents.map((event) => `http:${event.method}`),
    ]),
  ]
    .slice(0, RUN_UPLOAD_LIMITS.evidenceItems)
    .map((kind) => truncate(kind, RUN_UPLOAD_LIMITS.assertionKindLength));
}

function observedAssertionSummary(
  assertion: IrAssertion,
  result: LocalRunnerResult,
  fallback: string,
): string {
  if (assertion.kind === 'sequence.inOrder') {
    const evidence = assertionResultEvidence(result, assertion.id);
    if (Array.isArray(evidence)) {
      return `matched ${evidence.length} of ${assertion.steps.length} ordered steps`;
    }
  }
  return fallback;
}

function matcherDefinition(assertion: {
  matcher?: Extract<
    IrAssertion,
    {kind: 'tool.called'} | {kind: 'tool.notCalled'}
  >['matcher'];
}) {
  if (assertion.matcher === undefined) return {};
  if ('equals' in assertion.matcher) {
    return {matcher: {equals: truncateDetail(assertion.matcher.equals)}};
  }
  if ('includes' in assertion.matcher) {
    return {matcher: {includes: truncateDetail(assertion.matcher.includes)}};
  }
  if ('startsWith' in assertion.matcher) {
    return {
      matcher: {startsWith: truncateDetail(assertion.matcher.startsWith)},
    };
  }
  return {matcher: {matches: truncateDetail(assertion.matcher.matches)}};
}

function pathMatcherDefinition(assertion: {
  pathMatcher?: {path: string} | undefined;
}) {
  return assertion.pathMatcher === undefined
    ? {}
    : {pathMatcher: {path: truncateDetail(assertion.pathMatcher.path)}};
}

function describeToolStep(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.pathMatcher !== undefined) {
    return `tool.called(${step.toolKind}, path: ${step.pathMatcher.path})`;
  }
  if (step.matcher === undefined) return `tool.called(${step.toolKind})`;
  return `tool.called(${step.toolKind}, ${describeMatcher(step.matcher)})`;
}

function describeToolStepExpectation(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.pathMatcher !== undefined) {
    return `${step.toolKind} tool call for path "${step.pathMatcher.path}"`;
  }
  if (step.matcher === undefined) return `${step.toolKind} tool call`;
  return describeMatcherExpectation(step.matcher);
}

function describeMatcher(
  matcher: Extract<IrAssertion, {kind: 'tool.called'}>['matcher'],
): string {
  if (matcher === undefined) return '';
  if ('equals' in matcher) return `equals: ${matcher.equals}`;
  if ('includes' in matcher) return `includes: ${matcher.includes}`;
  if ('startsWith' in matcher) return `startsWith: ${matcher.startsWith}`;
  return `matches: ${matcher.matches}`;
}

function describeMatcherExpectation(
  matcher: Extract<IrAssertion, {kind: 'tool.called'}>['matcher'],
): string {
  if (matcher === undefined) return '';
  if ('equals' in matcher) return `shell command equal to "${matcher.equals}"`;
  if ('includes' in matcher) {
    return `shell command including "${matcher.includes}"`;
  }
  if ('startsWith' in matcher) {
    return `shell command starting with "${matcher.startsWith}"`;
  }
  return `shell command matching /${matcher.matches}/`;
}

function isToolEvent(value: unknown): value is ToolEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'rawName' in value &&
    typeof value.rawName === 'string'
  );
}

function isHttpEvent(value: unknown): value is HttpEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    typeof value.method === 'string' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

function formatHttpEvent(event: HttpEvent): string {
  const status = event.status === undefined ? '' : ` -> ${event.status}`;
  return `${event.method} ${event.url}${status}`;
}

function truncateDetail(value: string): string {
  return truncate(value, RUN_UPLOAD_LIMITS.assertionDetailLength);
}

function truncateNullableDetail(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : truncateDetail(trimmed);
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
