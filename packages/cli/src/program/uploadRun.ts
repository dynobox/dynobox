import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {
  describeCommandMatcher as describeCommandMatcherText,
  describeShellCommandMatcher,
} from '@dynobox/evaluators';
import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  type RunUploadAssertionDefinitionV2,
  type RunUploadAssertionDisplayChildV2,
  type RunUploadAssertionDisplayV2,
  type RunUploadAssertionEvidenceV2,
  type RunUploadAssertionV2,
  type RunUploadDynoV2,
  type RunUploadJobV2,
  type RunUploadV2 as RunUploadPayloadV2,
  RunUploadV2,
} from '@dynobox/run-schema';
import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
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
  anyOfBranchResults,
  anyOfMatchedBranch,
  assertionBranchWithId,
} from '../util/assertionBranch.js';
import {
  assertionResultEvidence,
  formatHttpEvent,
  isHttpEvent,
  isToolEvent,
} from '../util/evidence.js';
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
  const payloadResult = RunUploadV2.safeParse(payload);
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
}): RunUploadPayloadV2 {
  const allJobs = input.dynos.flatMap((dyno) => dyno.jobs);
  if (input.results.length !== allJobs.length) {
    throw new Error(
      `Expected ${allJobs.length} runner results for upload, but received ${input.results.length}.`,
    );
  }
  let offset = 0;
  const dynos = input.dynos.map((dyno) => {
    const results = input.results.slice(offset, offset + dyno.jobs.length);
    offset += dyno.jobs.length;
    return buildRunUploadDyno(dyno, results);
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
): RunUploadDynoV2 {
  const jobs = dyno.jobs.map((job, index) => {
    const result = results[index]!;
    return buildRunUploadJob(job, result);
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
): RunUploadJobV2 {
  const assertionById = assertionByIdForJobs([job]);
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
      version:
        result.harnessVersion === undefined || result.harnessVersion === null
          ? null
          : truncate(
              result.harnessVersion,
              RUN_UPLOAD_LIMITS.harnessVersionLength,
            ),
    },
    iteration: result.iteration + 1,
    status: result.status,
    passed: result.passed,
    durationMs: durationMs(result.timing.totalMs),
    assertions: result.assertionResults.map((assertion) => {
      const source = assertionById.get(assertion.assertionId);
      return compactAssertion({
        assertionId: assertion.assertionId,
        type: assertion.type,
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
  type: string;
  message: string;
  passed: boolean;
  result: LocalRunnerResult;
  source: IrAssertion | undefined;
}): RunUploadAssertionV2 {
  return {
    assertionId: truncate(
      input.assertionId,
      RUN_UPLOAD_LIMITS.assertionIdLength,
    ),
    label: truncate(
      assertionLabel(input.source, input.type),
      RUN_UPLOAD_LIMITS.assertionLabelLength,
    ),
    type: truncate(input.type, RUN_UPLOAD_LIMITS.assertionTypeLength),
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
  fallbackType: string,
): string {
  if (assertion === undefined) return fallbackType;
  const description = describeAssertion(assertion);
  return assertion.label === undefined
    ? description
    : `${assertion.label}  ${description}`;
}

function assertionDefinition(
  assertion: IrAssertion,
): RunUploadAssertionDefinitionV2 {
  const base = {type: assertion.type};
  if (assertion.type === 'tool.called' || assertion.type === 'tool.notCalled') {
    return {
      ...base,
      tool: assertion.tool,
      ...matcherDefinition(assertion),
      ...pathDefinition(assertion),
    };
  }
  if (
    assertion.type === 'command.called' ||
    assertion.type === 'command.notCalled'
  ) {
    return {
      ...base,
      executable: assertion.executable,
      ...commandMatcherDefinition(assertion),
    };
  }
  if (assertion.type === 'sequence.inOrder') {
    return {
      ...base,
      steps: assertion.steps.map(sequenceStepDefinition),
    };
  }
  if (assertion.type === 'anyOf') {
    return {
      ...base,
      steps: assertion.steps.map(assertionNodeDefinition),
    };
  }
  if (assertion.type === 'http.called') {
    return {
      ...base,
      endpointId: assertion.endpointId,
      ...(assertion.status === undefined ? {} : {status: assertion.status}),
    };
  }
  if (assertion.type === 'http.notCalled') {
    return {...base, endpointId: assertion.endpointId};
  }
  if (assertion.type === 'skill.referenced') {
    return {...base, skill: assertion.skill};
  }
  if (assertion.type === 'verify.command') {
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
  if (
    assertion.type === 'artifact.exists' ||
    assertion.type === 'artifact.notExists' ||
    assertion.type === 'artifact.unchanged'
  ) {
    return {...base, path: truncateDetail(assertion.path)};
  }
  if (assertion.type === 'artifact.contains') {
    return {
      ...base,
      path: truncateDetail(assertion.path),
      text: truncateDetail(assertion.text),
    };
  }
  if (
    assertion.type === 'transcript.contains' ||
    assertion.type === 'finalMessage.contains'
  ) {
    return {...base, text: truncateDetail(assertion.text)};
  }
  return base;
}

function assertionNodeDefinition(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>['steps'][number],
): RunUploadAssertionDefinitionV2 {
  return assertionDefinition(assertionBranchWithId(assertion));
}

function sequenceStepDefinition(
  step: Extract<IrAssertion, {type: 'sequence.inOrder'}>['steps'][number],
): NonNullable<RunUploadAssertionDefinitionV2['steps']>[number] {
  return step.type === 'tool.called'
    ? {
        type: step.type,
        tool: step.tool,
        ...matcherDefinition(step),
        ...pathDefinition(step),
      }
    : {
        type: step.type,
        executable: step.executable,
        ...commandMatcherDefinition(step),
      };
}

function assertionDisplay(
  assertion: IrAssertion,
  result: LocalRunnerResult,
  fallbackObserved: string,
): RunUploadAssertionDisplayV2 {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertion.id,
  );
  return {
    title: truncateDetail(assertionLabel(assertion, assertion.type)),
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
): RunUploadAssertionDisplayChildV2[] {
  if (assertion.type === 'sequence.inOrder') {
    return sequenceChildren(assertion, evidence);
  }
  if (assertion.type === 'anyOf') {
    return anyOfChildren(assertion, evidence);
  }
  return [];
}

function sequenceChildren(
  assertion: Extract<IrAssertion, {type: 'sequence.inOrder'}>,
  evidence: unknown,
): RunUploadAssertionDisplayChildV2[] {
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
      type: step.type,
      title: truncateDetail(describeToolStep(step)),
      expectation: truncateDetail(describeToolStepExpectation(step)),
      observed: null,
      passed,
    };
  });
}

function anyOfChildren(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>,
  evidence: unknown,
): RunUploadAssertionDisplayChildV2[] {
  const branchResults = anyOfBranchResults(evidence);
  return assertion.steps.map((step, index) => {
    const branch = stepWithId(step);
    const result = branchResults?.[index];
    return {
      index: index + 1,
      type: branch.type,
      title: truncateDetail(describeAssertion(branch)),
      expectation: truncateDetail(describeExpectation(branch)),
      observed: truncateNullableDetail(result?.message ?? null),
      passed: result?.passed ?? null,
    };
  });
}

function assertionEvidence(
  result: LocalRunnerResult,
  assertionId: string,
  assertion: IrAssertion | undefined,
  passed: boolean,
): RunUploadAssertionEvidenceV2 {
  const evidence = assertionResultEvidence(
    result.assertionResults,
    assertionId,
  );
  const matches =
    assertion?.type === 'command.called' && !passed
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
    .map((kind) => truncate(kind, RUN_UPLOAD_LIMITS.assertionTypeLength));
}

function observedAssertionSummary(
  assertion: IrAssertion,
  result: LocalRunnerResult,
  fallback: string,
): string {
  if (assertion.type === 'command.called') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
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

  if (assertion.type === 'sequence.inOrder') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    if (Array.isArray(evidence)) {
      return `matched ${evidence.length} of ${assertion.steps.length} ordered steps`;
    }
  }

  if (assertion.type === 'anyOf') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    const matchedBranch = anyOfMatchedBranch(evidence);
    if (matchedBranch !== undefined) return `matched branch #${matchedBranch}`;
    const branchResults = anyOfBranchResults(evidence);
    if (branchResults !== undefined) {
      return `0 of ${branchResults.length} branches matched`;
    }
  }

  if (assertion.type === 'verify.command') {
    const evidence = assertionResultEvidence(
      result.assertionResults,
      assertion.id,
    );
    if (isVerifyCommandResult(evidence)) {
      return formatVerifyCommandResult(evidence);
    }
  }
  return fallback;
}

function stepWithId(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>['steps'][number],
): IrAssertion {
  return assertionBranchWithId(assertion);
}

function matcherDefinition(assertion: {
  command?: Extract<
    IrAssertion,
    {type: 'tool.called'} | {type: 'tool.notCalled'}
  >['command'];
}) {
  if (assertion.command === undefined) return {};
  if ('equals' in assertion.command) {
    return {command: {equals: truncateDetail(assertion.command.equals)}};
  }
  if ('includes' in assertion.command) {
    return {command: {includes: truncateDetail(assertion.command.includes)}};
  }
  if ('startsWith' in assertion.command) {
    return {
      command: {startsWith: truncateDetail(assertion.command.startsWith)},
    };
  }
  return {command: {matches: truncateDetail(assertion.command.matches)}};
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

function pathDefinition(assertion: {path?: string | undefined}) {
  return assertion.path === undefined
    ? {}
    : {path: truncateDetail(assertion.path)};
}

function commandMatcherDefinition(assertion: {
  command?: Extract<
    IrAssertion,
    {type: 'command.called'} | {type: 'command.notCalled'}
  >['command'];
}) {
  if (assertion.command === undefined) return {};
  return {
    command: {
      ...(assertion.command.args === undefined
        ? {}
        : {args: assertion.command.args.map(truncateDetail)}),
      ...(assertion.command.argsInOrder === undefined
        ? {}
        : {argsInOrder: assertion.command.argsInOrder.map(truncateDetail)}),
      ...(assertion.command.argsMatching === undefined
        ? {}
        : {
            argsMatching: assertion.command.argsMatching.map((pattern) => ({
              source: truncateDetail(pattern.source),
              flags: pattern.flags,
            })),
          }),
      ...(assertion.command.originalIncludes === undefined
        ? {}
        : {
            originalIncludes: truncateDetail(
              assertion.command.originalIncludes,
            ),
          }),
      ...(assertion.command.originalMatches === undefined
        ? {}
        : {
            originalMatches: {
              source: truncateDetail(assertion.command.originalMatches.source),
              flags: assertion.command.originalMatches.flags,
            },
          }),
    },
  };
}

function describeToolStep(
  step: Extract<IrAssertion, {type: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.type === 'command.called') {
    if (step.command === undefined) return `command.called(${step.executable})`;
    return `command.called(${step.executable}, ${describeCommandMatcher(step.command)})`;
  }
  if (step.path !== undefined) {
    return `tool.called(${step.tool}, path: ${step.path})`;
  }
  if (step.command === undefined) return `tool.called(${step.tool})`;
  return `tool.called(${step.tool}, ${describeMatcher(step.command)})`;
}

function describeToolStepExpectation(
  step: Extract<IrAssertion, {type: 'sequence.inOrder'}>['steps'][number],
): string {
  if (step.type === 'command.called') {
    if (step.command === undefined) return `${step.executable} command`;
    return `${step.executable} command with ${describeCommandMatcher(step.command)}`;
  }
  if (step.path !== undefined) {
    return `${step.tool} tool call for path "${step.path}"`;
  }
  if (step.command === undefined) return `${step.tool} tool call`;
  return describeMatcherExpectation(step.command);
}

function describeMatcher(
  matcher: Extract<IrAssertion, {type: 'tool.called'}>['command'],
): string {
  if (matcher === undefined) return '';
  return describeShellCommandMatcher(matcher, {style: 'compact'});
}

function describeMatcherExpectation(
  matcher: Extract<IrAssertion, {type: 'tool.called'}>['command'],
): string {
  if (matcher === undefined) return '';
  return describeShellCommandMatcher(matcher, {style: 'expectation'});
}

function describeCommandMatcher(
  matcher: NonNullable<
    Extract<IrAssertion, {type: 'command.called'}>['command']
  >,
): string {
  return describeCommandMatcherText(matcher, {style: 'compact'});
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
