import {DynoboxConfigError} from '../errors.js';
import {type AuthoredAssertion, configSchema} from '../schema/configSchema.js';
import type {Endpoint} from '../types/brands.js';
import type {DynoboxConfig} from '../types/config.js';
import type {HarnessRunConfig} from '../types/harness.js';
import {slugify, uniquify} from './ids.js';
import {
  type Ir,
  IR_VERSION,
  type IrAssertion,
  type IrAssertionNode,
  type IrEndpoint,
  type IrHarnessConfig,
  type IrScenario,
  type IrSequenceStep,
} from './types.js';

const SCENARIO_PREFIX = 'scenario.';

type IrAssertionBody = IrAssertion extends infer Assertion
  ? Assertion extends IrAssertion
    ? Omit<Assertion, 'id' | 'label'>
    : never
  : never;
type AuthoredSequenceStep = Extract<
  AuthoredAssertion,
  {type: 'sequence.inOrder'}
>['steps'][number];
type AuthoredAnyOfBranch = Extract<
  AuthoredAssertion,
  {type: 'anyOf'}
>['steps'][number];
type IrVerifyCommandBody = Omit<
  Extract<IrAssertion, {kind: 'verify.command'}>,
  'id' | 'label'
>;

/**
 * Validates an author config and emits the canonical IR. Throws
 * `DynoboxConfigError` if any assertion references an unknown endpoint.
 *
 * @param config The author config to compile.
 * @returns The canonical IR with stable IDs.
 */
export function compile(config: DynoboxConfig): Ir {
  const parsed = configSchema.parse(config);

  const scenarioSlugs = new Set<string>();
  const irScenarios: IrScenario[] = parsed.scenarios.map((scenario) => {
    const scenarioSlug =
      scenario.id === undefined
        ? uniquify(slugify(scenario.name), scenarioSlugs)
        : reserveAuthoredId(scenario.id, scenarioSlugs, 'scenario');
    const scenarioId = `${SCENARIO_PREFIX}${scenarioSlug}`;

    const mergedEndpoints: Record<string, Endpoint> = {
      ...(parsed.endpoints ?? {}),
      ...(scenario.endpoints ?? {}),
    };

    const irEndpoints: IrEndpoint[] = Object.entries(mergedEndpoints).map(
      ([key, endpoint]) => buildIrEndpoint(scenarioSlug, key, endpoint),
    );

    const endpointIdByKey = new Map(
      Object.keys(mergedEndpoints).map((key) => [
        key,
        `endpoint.${scenarioSlug}.${key}`,
      ]),
    );

    const assertionIds = new Set<string>();
    const irAssertions: IrAssertion[] = (scenario.assertions ?? []).map(
      (assertion, index) => {
        const assertionIdSuffix =
          assertion.id === undefined
            ? reserveGeneratedId(String(index), assertionIds)
            : reserveAuthoredId(assertion.id, assertionIds, 'assertion');
        return buildIrAssertion(
          scenario.name,
          scenarioSlug,
          assertionIdSuffix,
          index,
          endpointIdByKey,
          assertion,
        );
      },
    );

    const harnesses = (
      scenario.harnesses ??
      parsed.harnesses ?? ['claude-code']
    ).map(normalizeHarnessConfig);

    const setup: string[] = [
      ...(parsed.setup ?? []),
      ...(scenario.setup ?? []),
    ];

    const fixtures = dedupeStrings(toStringArray(scenario.fixtures));

    return {
      id: scenarioId,
      name: scenario.name,
      prompt: scenario.prompt,
      harnesses,
      setup,
      fixtures,
      endpoints: irEndpoints,
      assertions: irAssertions,
    };
  });

  const ir: Ir = {
    version: IR_VERSION,
    scenarios: irScenarios,
  };
  if (parsed.name !== undefined) ir.name = parsed.name;
  if (parsed.target !== undefined) ir.target = parsed.target;
  return ir;
}

function normalizeHarnessConfig(harness: HarnessRunConfig): IrHarnessConfig {
  return typeof harness === 'string' ? {id: harness} : harness;
}

function toStringArray(
  value: string | readonly string[] | undefined,
): string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : [...value];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildIrEndpoint(
  scenarioSlug: string,
  key: string,
  endpoint: Endpoint,
): IrEndpoint {
  const ir: IrEndpoint = {
    id: `endpoint.${scenarioSlug}.${key}`,
    key,
    method: endpoint.method,
    url: endpoint.url,
  };
  if (endpoint.headers !== undefined) ir.headers = endpoint.headers;
  if (endpoint.body !== undefined) ir.body = endpoint.body;
  if (endpoint.response !== undefined) ir.response = endpoint.response;
  return ir;
}

function buildIrAssertion(
  scenarioName: string,
  scenarioSlug: string,
  assertionIdSuffix: string,
  index: number,
  endpointIdByKey: Map<string, string>,
  assertion: AuthoredAssertion,
): IrAssertion {
  const id = `assertion.${scenarioSlug}.${assertionIdSuffix}`;
  const metadata =
    assertion.label === undefined ? {} : {label: assertion.label};
  // `buildIrAssertionNode` returns the assertion body; adding the generated
  // ID and optional metadata restores the complete discriminated union.
  return {
    id,
    ...metadata,
    ...buildIrAssertionNode(scenarioName, index, endpointIdByKey, assertion),
  } as IrAssertion;
}

function buildIrAssertionNode(
  scenarioName: string,
  index: number,
  endpointIdByKey: Map<string, string>,
  assertion: AuthoredAssertion,
): IrAssertionBody {
  if (assertion.type === 'tool.called') {
    return buildIrToolCalledStep(assertion);
  }

  if (assertion.type === 'tool.notCalled') {
    const base = {
      kind: 'tool.notCalled' as const,
      toolKind: assertion.tool,
    };
    if (assertion.command !== undefined) {
      return {...base, matcher: assertion.command};
    }
    if (assertion.path !== undefined) {
      return {...base, pathMatcher: {path: assertion.path}};
    }
    return base;
  }

  if (assertion.type === 'command.called') {
    return buildIrCommandCalledStep(assertion);
  }

  if (assertion.type === 'command.notCalled') {
    const base = {
      kind: 'command.notCalled' as const,
      executable: assertion.executable,
    };
    return assertion.command === undefined
      ? base
      : {...base, matcher: serializeCommandMatcher(assertion.command)};
  }

  if (assertion.type === 'verify.command') {
    return buildIrVerifyCommandAssertion(assertion);
  }

  if (assertion.type === 'artifact.exists') {
    return {kind: 'artifact.exists', path: assertion.path};
  }

  if (assertion.type === 'artifact.contains') {
    return {
      kind: 'artifact.contains',
      path: assertion.path,
      text: assertion.text,
    };
  }

  if (assertion.type === 'transcript.contains') {
    return {kind: 'transcript.contains', text: assertion.text};
  }

  if (assertion.type === 'finalMessage.contains') {
    return {
      kind: 'finalMessage.contains',
      text: assertion.text,
    };
  }

  if (assertion.type === 'sequence.inOrder') {
    return {
      kind: 'sequence.inOrder',
      steps: assertion.steps.map((step) => buildIrSequenceStep(step)),
    };
  }

  if (assertion.type === 'anyOf') {
    return {
      kind: 'anyOf',
      steps: assertion.steps.map((step) =>
        buildIrAnyOfBranch(scenarioName, index, endpointIdByKey, step),
      ),
    };
  }

  if (assertion.type === 'skill.referenced') {
    return {kind: 'skill.referenced', skill: assertion.skill};
  }

  const endpointId = endpointIdByKey.get(assertion.endpoint);
  if (endpointId === undefined) {
    throw new DynoboxConfigError(
      `Scenario "${scenarioName}" assertion #${index} references unknown endpoint "${assertion.endpoint}". ` +
        `Known endpoints: ${[...endpointIdByKey.keys()].join(', ') || '(none)'}`,
    );
  }

  if (assertion.type === 'http.called') {
    const base = {
      kind: 'http.called' as const,
      endpointId,
    };
    if (assertion.status !== undefined) {
      return {...base, status: assertion.status};
    }
    return base;
  }
  return {kind: 'http.notCalled', endpointId};
}

function buildIrSequenceStep(assertion: AuthoredSequenceStep): IrSequenceStep {
  if (assertion.type === 'tool.called') {
    return buildIrToolCalledStep(assertion);
  }
  return buildIrCommandCalledStep(assertion);
}

function buildIrAnyOfBranch(
  scenarioName: string,
  index: number,
  endpointIdByKey: Map<string, string>,
  assertion: AuthoredAnyOfBranch,
): IrAssertionNode {
  // Authoring validation excludes nested sequence, anyOf, and verify nodes,
  // leaving exactly the node variants accepted by the IR schema.
  return buildIrAssertionNode(
    scenarioName,
    index,
    endpointIdByKey,
    assertion,
  ) as IrAssertionNode;
}

function buildIrToolCalledStep(
  assertion: Extract<AuthoredAssertion, {type: 'tool.called'}>,
): Omit<Extract<IrAssertion, {kind: 'tool.called'}>, 'id'> {
  const base = {
    kind: 'tool.called' as const,
    toolKind: assertion.tool,
  };
  if (assertion.command !== undefined) {
    return {...base, matcher: assertion.command} as Omit<
      Extract<IrAssertion, {kind: 'tool.called'}>,
      'id'
    >;
  }
  if (assertion.path !== undefined) {
    return {...base, pathMatcher: {path: assertion.path}} as Omit<
      Extract<IrAssertion, {kind: 'tool.called'}>,
      'id'
    >;
  }
  return base as Omit<Extract<IrAssertion, {kind: 'tool.called'}>, 'id'>;
}

function buildIrCommandCalledStep(
  assertion: Extract<AuthoredAssertion, {type: 'command.called'}>,
): Omit<Extract<IrAssertion, {kind: 'command.called'}>, 'id'> {
  const base = {
    kind: 'command.called' as const,
    executable: assertion.executable,
  };
  return assertion.command === undefined
    ? base
    : {...base, matcher: serializeCommandMatcher(assertion.command)};
}

function serializeCommandMatcher(
  matcher: Extract<
    AuthoredAssertion,
    {type: 'command.called' | 'command.notCalled'}
  >['command'],
): NonNullable<Extract<IrAssertion, {kind: 'command.called'}>['matcher']> {
  const serialized: NonNullable<
    Extract<IrAssertion, {kind: 'command.called'}>['matcher']
  > = {};
  if (matcher?.args !== undefined) serialized.args = [...matcher.args];
  if (matcher?.argsInOrder !== undefined) {
    serialized.argsInOrder = [...matcher.argsInOrder];
  }
  if (matcher?.argsMatching !== undefined) {
    serialized.argsMatching = matcher.argsMatching.map(serializeRegExp);
  }
  if (matcher?.originalIncludes !== undefined) {
    serialized.originalIncludes = matcher.originalIncludes;
  }
  if (matcher?.originalMatches !== undefined) {
    serialized.originalMatches = serializeRegExp(matcher.originalMatches);
  }
  return serialized;
}

function buildIrVerifyCommandAssertion(
  assertion: Extract<AuthoredAssertion, {type: 'verify.command'}>,
): IrVerifyCommandBody {
  const ir = {
    kind: 'verify.command',
    command: assertion.command,
  } as IrVerifyCommandBody;
  if (assertion.exitCode !== undefined) ir.exitCode = assertion.exitCode;
  if (assertion.stdout !== undefined) ir.stdout = assertion.stdout;
  if (assertion.stderr !== undefined) ir.stderr = assertion.stderr;
  return ir;
}

function serializeRegExp(regex: RegExp): {source: string; flags: string} {
  return {source: regex.source, flags: regex.flags};
}

function reserveAuthoredId(
  id: string,
  taken: Set<string>,
  label: 'scenario' | 'assertion',
): string {
  if (taken.has(id)) {
    throw new DynoboxConfigError(`Duplicate ${label} id "${id}".`);
  }
  taken.add(id);
  return id;
}

function reserveGeneratedId(id: string, taken: Set<string>): string {
  return uniquify(id, taken);
}
