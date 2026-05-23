import type {z} from 'zod';

import {DynoboxConfigError} from '../errors.js';
import {assertionSchema, configSchema} from '../schema/configSchema.js';
import type {Endpoint} from '../types/brands.js';
import type {DynoboxConfig} from '../types/config.js';
import type {HarnessRunConfig} from '../types/harness.js';
import {slugify, uniquify} from './ids.js';
import {
  type Ir,
  IR_VERSION,
  type IrAssertion,
  type IrEndpoint,
  type IrHarnessConfig,
  type IrScenario,
} from './types.js';

const SCENARIO_PREFIX = 'scenario.';

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
  return ir;
}

function normalizeHarnessConfig(harness: HarnessRunConfig): IrHarnessConfig {
  return typeof harness === 'string' ? {id: harness} : harness;
}

function toStringArray(value: string | readonly string[] | undefined): string[] {
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
  assertion: z.infer<typeof assertionSchema>,
): IrAssertion {
  const id = `assertion.${scenarioSlug}.${assertionIdSuffix}`;
  const metadata =
    assertion.label === undefined ? {} : {label: assertion.label};
  if (assertion.type === 'tool.called') {
    return {id, ...metadata, ...buildIrToolCalledStep(assertion)};
  }

  if (assertion.type === 'tool.notCalled') {
    const base: IrAssertion = {
      id,
      ...metadata,
      kind: 'tool.notCalled',
      toolKind: assertion.tool,
    };
    return assertion.command === undefined
      ? base
      : {...base, matcher: assertion.command};
  }

  if (assertion.type === 'artifact.exists') {
    return {id, ...metadata, kind: 'artifact.exists', path: assertion.path};
  }

  if (assertion.type === 'artifact.contains') {
    return {
      id,
      ...metadata,
      kind: 'artifact.contains',
      path: assertion.path,
      text: assertion.text,
    };
  }

  if (assertion.type === 'transcript.contains') {
    return {id, ...metadata, kind: 'transcript.contains', text: assertion.text};
  }

  if (assertion.type === 'finalMessage.contains') {
    return {
      id,
      ...metadata,
      kind: 'finalMessage.contains',
      text: assertion.text,
    };
  }

  if (assertion.type === 'sequence.inOrder') {
    return {
      id,
      ...metadata,
      kind: 'sequence.inOrder',
      steps: assertion.steps.map(buildIrToolCalledStep),
    };
  }

  if (assertion.type === 'skill.invoked') {
    return {id, ...metadata, kind: 'skill.invoked', skill: assertion.skill};
  }

  const endpointId = endpointIdByKey.get(assertion.endpoint);
  if (endpointId === undefined) {
    throw new DynoboxConfigError(
      `Scenario "${scenarioName}" assertion #${index} references unknown endpoint "${assertion.endpoint}". ` +
        `Known endpoints: ${[...endpointIdByKey.keys()].join(', ') || '(none)'}`,
    );
  }

  if (assertion.type === 'http.called') {
    const base: IrAssertion = {
      id,
      ...metadata,
      kind: 'http.called',
      endpointId,
    };
    if (assertion.status !== undefined) {
      return {...base, status: assertion.status};
    }
    return base;
  }
  return {id, ...metadata, kind: 'http.notCalled', endpointId};
}

function buildIrToolCalledStep(
  assertion: Extract<z.infer<typeof assertionSchema>, {type: 'tool.called'}>,
): Omit<Extract<IrAssertion, {kind: 'tool.called'}>, 'id'> {
  const base = {
    kind: 'tool.called' as const,
    toolKind: assertion.tool,
  };
  return (
    assertion.command === undefined
      ? base
      : {...base, matcher: assertion.command}
  ) as Omit<Extract<IrAssertion, {kind: 'tool.called'}>, 'id'>;
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
