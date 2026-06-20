import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  type RunUploadAssertionDefinitionV1,
  type RunUploadAssertionDisplayChildV1,
  type RunUploadAssertionDisplayV1,
  type RunUploadAssertionEvidenceV1,
  type RunUploadAssertionV1,
  type RunUploadDynoV1,
  type RunUploadJobV1,
  type RunUploadV1 as RunUploadPayloadV1,
  RunUploadV1,
} from '@dynobox/run-schema';
import type {
  HttpEvent,
  LocalRunnerJob,
  LocalRunnerResult,
  ToolEvent,
} from '@dynobox/runner-local';
import type {TextMatcher} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

import {assertionByIdForJobs} from '../jobs.js';
import {
  describeAssertion,
  describeExpectation,
  describeToolEvent,
  isObservedCommand,
} from '../render/describe.js';
import {
  formatVerifyCommandResult,
  isVerifyCommandResult,
} from '../util/verifyCommandResult.js';
import {readPackageVersion} from '../util/version.js';
import {type AuthEnvironment, resolveAuthToken} from './auth.js';
import {resolveApiUrl} from './identityApi.js';

const execFileAsync = promisify(execFile);
const RUN_UPLOAD_TIMEOUT_MS = 10_000;

/**
 * One compiled dyno file's slice of the run. `jobs` must appear in the same
 * order they were executed so `results` can be re-aligned positionally.
 */
export type UploadRunDynoInput = {
  /** Path of the authored .dyno file relative to the working directory. */
  dynoPath: string;
  /** Authored config name, when the dyno declared one. */
  name: string | null;
  /** The thing being tested; groups dynos on the dashboard. */
  target: string;
  jobs: readonly LocalRunnerJob[];
};

export type UploadRunInput = {
  dynos: readonly UploadRunDynoInput[];
  /** One result per job, flattened across `dynos` in execution order. */
  results: readonly LocalRunnerResult[];
  runFailed: boolean;
  /** The path the CLI was pointed at (`dynobox run <inputPath>`). */
  inputPath: string;
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
    dynos: input.dynos,
    results: input.results,
    runFailed: input.runFailed,
    inputPath: input.inputPath,
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
  dynos: readonly UploadRunDynoInput[];
  results: readonly LocalRunnerResult[];
  runFailed?: boolean;
  inputPath: string;
  gitHash: string | null;
}): RunUploadPayloadV1 {
  const allJobs = input.dynos.flatMap((dyno) => dyno.jobs);
  const assertionById = assertionByIdForJobs(allJobs);

  let offset = 0;
  const dynos = input.dynos.map((dyno) => {
    const results = input.results.slice(offset, offset + dyno.jobs.length);
    offset += dyno.jobs.length;
    return buildRunUploadDyno(dyno, results, assertionById);
  });

  const failed = dynos.reduce((count, dyno) => count + dyno.totals.failed, 0);
  return {
    schemaVersion: RUN_UPLOAD_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    cliVersion: readPackageVersion(),
    gitHash: input.gitHash,
    inputPath: truncate(input.inputPath, RUN_UPLOAD_LIMITS.inputPathLength),
    status: input.runFailed === true || failed > 0 ? 'failed' : 'passed',
    totals: {
      jobs: dynos.reduce((count, dyno) => count + dyno.totals.jobs, 0),
      passed: dynos.reduce((count, dyno) => count + dyno.totals.passed, 0),
      failed,
      warnings: dynos.reduce((count, dyno) => count + dyno.totals.warnings, 0),
      durationMs: dynos.reduce(
        (total, dyno) => total + dyno.totals.durationMs,
        0,
      ),
    },
    dynos,
  };
}

function buildRunUploadDyno(
  dyno: UploadRunDynoInput,
  results: readonly LocalRunnerResult[],
  assertionById: ReadonlyMap<string, IrAssertion>,
): RunUploadDynoV1 {
  const jobs = results.map((result, index) => {
    const job = dyno.jobs[index] ?? jobFromResult(result);
    return buildRunUploadJob(job, result, assertionById);
  });
  const failed = jobs.filter((job) => !job.passed).length;

  return {
    dynoPath: truncate(dyno.dynoPath, RUN_UPLOAD_LIMITS.dynoPathLength),
    name:
      dyno.name === null
        ? null
        : truncate(dyno.name, RUN_UPLOAD_LIMITS.dynoNameLength),
    target: truncate(dyno.target, RUN_UPLOAD_LIMITS.targetLength),
    status: failed > 0 ? 'failed' : 'passed',
    totals: {
      jobs: jobs.length,
      passed: jobs.length - failed,
      failed,
      warnings: jobs.reduce((count, job) => count + job.warnings.length, 0),
      durationMs: durationMs(
        results.reduce((total, result) => total + result.timing.totalMs, 0),
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
    diagnostics: result.diagnostics
      .map((diagnostic) => diagnostic.trim())
      .filter((diagnostic) => diagnostic.length > 0)
      .slice(0, RUN_UPLOAD_LIMITS.diagnosticsPerJob)
      .map((diagnostic) =>
        truncate(diagnostic, RUN_UPLOAD_LIMITS.diagnosticLength),
      ),
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
    evidence: assertionEvidence(
      input.result,
      input.assertionId,
      input.source,
      input.passed,
    ),
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
  if (
    assertion.kind === 'command.called' ||
    assertion.kind === 'command.notCalled'
  ) {
    return {
      ...base,
      executable: assertion.executable,
      ...commandMatcherDefinition(assertion),
    };
  }
  if (assertion.kind === 'sequence.inOrder') {
    return {
      ...base,
      steps: assertion.steps.map(sequenceStepDefinition),
    };
  }
  if (assertion.kind === 'anyOf') {
    return {
      ...base,
      steps: assertion.steps.map(assertionNodeDefinition),
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
  if (assertion.kind === 'skill.referenced') {
    return {...base, skill: assertion.skill};
  }
  if (assertion.kind === 'verify.command') {
    return {
      ...base,
      command: truncateDetail(assertion.command),
      ...(assertion.exitCode === undefined
        ? {}
        : {exitCode: assertion.exitCode}),
      ...(assertion.stdout === undefined
        ? {}
        : {stdout: textMatcherUploadValue(assertion.stdout)}),
      ...(assertion.stderr === undefined
        ? {}
        : {stderr: textMatcherUploadValue(assertion.stderr)}),
    };
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

function assertionNodeDefinition(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>['steps'][number],
): RunUploadAssertionDefinitionV1 {
  return assertionDefinition({
    id: 'assertion.branch',
    ...(assertion as Record<string, unknown>),
  } as IrAssertion);
}

function sequenceStepDefinition(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): NonNullable<RunUploadAssertionDefinitionV1['steps']>[number] {
  if (step.kind === 'anyOf') {
    return {
      kind: step.kind,
      steps: step.steps.map(sequenceStepDefinition),
    };
  }
  return step.kind === 'tool.called'
    ? {
        kind: step.kind,
        toolKind: step.toolKind,
        ...matcherDefinition(step),
        ...pathMatcherDefinition(step),
      }
    : {
        kind: step.kind,
        executable: step.executable,
        ...commandMatcherDefinition(step),
      };
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
    children: assertionChildren(assertion, evidence),
  };
}

function assertionChildren(
  assertion: IrAssertion,
  evidence: unknown,
): RunUploadAssertionDisplayChildV1[] {
  if (assertion.kind === 'sequence.inOrder') {
    return sequenceChildren(assertion, evidence);
  }
  if (assertion.kind === 'anyOf') {
    return anyOfChildren(assertion, evidence);
  }
  return [];
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

function anyOfChildren(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>,
  evidence: unknown,
): RunUploadAssertionDisplayChildV1[] {
  const matchedBranch = anyOfMatchedBranch(evidence);
  return assertion.steps.map((step, index) => {
    const branch = stepWithId(step);
    return {
      index: index + 1,
      kind: branch.kind,
      title: truncateDetail(describeAssertion(branch)),
      expectation: truncateDetail(describeExpectation(branch)),
      observed: null,
      passed: matchedBranch === undefined ? null : matchedBranch === index + 1,
    };
  });
}

function assertionEvidence(
  result: LocalRunnerResult,
  assertionId: string,
  assertion: IrAssertion | undefined,
  passed: boolean,
): RunUploadAssertionEvidenceV1 {
  const evidence = assertionResultEvidence(result, assertionId);
  const matches =
    assertion?.kind === 'command.called' && !passed
      ? []
      : evidenceMatches(evidence);
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
    if (isObservedCommand(value)) {
      return [truncateDetail([value.executable, ...value.argv].join(' '))];
    }
    if (isVerifyCommandResult(value)) {
      return [truncateDetail(formatVerifyCommandResult(value))];
    }
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
  if (assertion.kind === 'command.called') {
    const evidence = assertionResultEvidence(result, assertion.id);
    if (Array.isArray(evidence) && evidence.every(isObservedCommand)) {
      return evidence.length === 0
        ? 'no commands observed'
        : evidence
            .map((command, index) =>
              truncateDetail(
                `${index + 1}. ${[command.executable, ...command.argv].join(' ')}`,
              ),
            )
            .join(' ');
    }
  }

  if (assertion.kind === 'sequence.inOrder') {
    const evidence = assertionResultEvidence(result, assertion.id);
    if (Array.isArray(evidence)) {
      return `matched ${evidence.length} of ${assertion.steps.length} ordered steps`;
    }
  }

  if (assertion.kind === 'anyOf') {
    const evidence = assertionResultEvidence(result, assertion.id);
    const matchedBranch = anyOfMatchedBranch(evidence);
    if (matchedBranch !== undefined) return `matched branch #${matchedBranch}`;
    if (isAnyOfFailureEvidence(evidence)) {
      return `0 of ${evidence.branches.length} branches matched`;
    }
  }

  if (assertion.kind === 'verify.command') {
    const evidence = assertionResultEvidence(result, assertion.id);
    if (isVerifyCommandResult(evidence)) {
      return formatVerifyCommandResult(evidence);
    }
  }
  return fallback;
}

function stepWithId(
  assertion: Extract<IrAssertion, {kind: 'anyOf'}>['steps'][number],
): IrAssertion {
  return {
    id: 'assertion.branch',
    ...(assertion as Record<string, unknown>),
  } as IrAssertion;
}

function anyOfMatchedBranch(evidence: unknown): number | undefined {
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  if (!('kind' in evidence) || evidence.kind !== 'anyOf') return undefined;
  if (!('branchIndex' in evidence)) return undefined;
  return typeof evidence.branchIndex === 'number'
    ? evidence.branchIndex
    : undefined;
}

function isAnyOfFailureEvidence(
  evidence: unknown,
): evidence is {kind: 'anyOf'; branches: unknown[]} {
  return (
    typeof evidence === 'object' &&
    evidence !== null &&
    'kind' in evidence &&
    evidence.kind === 'anyOf' &&
    'branches' in evidence &&
    Array.isArray(evidence.branches)
  );
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

function textMatcherUploadValue(matcher: TextMatcher) {
  if ('equals' in matcher) return {equals: truncateDetail(matcher.equals)};
  if ('includes' in matcher)
    return {includes: truncateDetail(matcher.includes)};
  if ('startsWith' in matcher) {
    return {startsWith: truncateDetail(matcher.startsWith)};
  }
  return {matches: truncateDetail(matcher.matches)};
}

function pathMatcherDefinition(assertion: {
  pathMatcher?: {path: string} | undefined;
}) {
  return assertion.pathMatcher === undefined
    ? {}
    : {pathMatcher: {path: truncateDetail(assertion.pathMatcher.path)}};
}

function commandMatcherDefinition(assertion: {
  matcher?: Extract<
    IrAssertion,
    {kind: 'command.called'} | {kind: 'command.notCalled'}
  >['matcher'];
}) {
  if (assertion.matcher === undefined) return {};
  return {
    commandMatcher: {
      ...(assertion.matcher.args === undefined
        ? {}
        : {args: assertion.matcher.args.map(truncateDetail)}),
      ...(assertion.matcher.argsInOrder === undefined
        ? {}
        : {argsInOrder: assertion.matcher.argsInOrder.map(truncateDetail)}),
      ...(assertion.matcher.argsMatching === undefined
        ? {}
        : {
            argsMatching: assertion.matcher.argsMatching.map((pattern) => ({
              source: truncateDetail(pattern.source),
              flags: pattern.flags,
            })),
          }),
      ...(assertion.matcher.originalIncludes === undefined
        ? {}
        : {
            originalIncludes: truncateDetail(
              assertion.matcher.originalIncludes,
            ),
          }),
      ...(assertion.matcher.originalMatches === undefined
        ? {}
        : {
            originalMatches: {
              source: truncateDetail(assertion.matcher.originalMatches.source),
              flags: assertion.matcher.originalMatches.flags,
            },
          }),
    },
  };
}

function describeToolStep(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.kind === 'anyOf') return `anyOf(${step.steps.length} branches)`;
  if (step.kind === 'command.called') {
    if (step.matcher === undefined) return `command.called(${step.executable})`;
    return `command.called(${step.executable}, ${describeCommandMatcher(step.matcher)})`;
  }
  if (step.pathMatcher !== undefined) {
    return `tool.called(${step.toolKind}, path: ${step.pathMatcher.path})`;
  }
  if (step.matcher === undefined) return `tool.called(${step.toolKind})`;
  return `tool.called(${step.toolKind}, ${describeMatcher(step.matcher)})`;
}

function describeToolStepExpectation(
  step: Extract<IrAssertion, {kind: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.kind === 'anyOf') {
    return step.steps.map(describeToolStepExpectation).join(' or ');
  }
  if (step.kind === 'command.called') {
    if (step.matcher === undefined) return `${step.executable} command`;
    return `${step.executable} command with ${describeCommandMatcher(step.matcher)}`;
  }
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

function describeCommandMatcher(
  matcher: NonNullable<
    Extract<IrAssertion, {kind: 'command.called'}>['matcher']
  >,
): string {
  const parts: string[] = [];
  if (matcher.args !== undefined)
    parts.push(`args: ${JSON.stringify(matcher.args)}`);
  if (matcher.argsInOrder !== undefined) {
    parts.push(`argsInOrder: ${JSON.stringify(matcher.argsInOrder)}`);
  }
  if (matcher.argsMatching !== undefined) {
    parts.push(
      `argsMatching: ${matcher.argsMatching.map((pattern) => `/${pattern.source}/${pattern.flags}`).join(', ')}`,
    );
  }
  if (matcher.originalIncludes !== undefined) {
    parts.push(`originalIncludes: ${matcher.originalIncludes}`);
  }
  if (matcher.originalMatches !== undefined) {
    parts.push(
      `originalMatches: /${matcher.originalMatches.source}/${matcher.originalMatches.flags}`,
    );
  }
  return parts.join(', ');
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
