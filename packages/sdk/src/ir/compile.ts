import type {z} from 'zod';

import {DynoboxConfigError} from '../errors.js';
import {assertionSchema, configSchema} from '../schema/config-schema.js';
import type {Endpoint} from '../types/brands.js';
import type {DynoboxConfig} from '../types/config.js';
import type {HarnessId} from '../types/harness.js';
import {slugify, uniquify} from './ids.js';
import {
  type Ir,
  IR_VERSION,
  type IrAssertion,
  type IrEndpoint,
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
    const scenarioId = `${SCENARIO_PREFIX}${uniquify(slugify(scenario.name), scenarioSlugs)}`;
    const scenarioSlug = scenarioId.slice(SCENARIO_PREFIX.length);

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

    const irAssertions: IrAssertion[] = (scenario.assertions ?? []).map(
      (assertion, index) => {
        const endpointId = endpointIdByKey.get(assertion.endpoint);
        if (endpointId === undefined) {
          throw new DynoboxConfigError(
            `Scenario "${scenario.name}" assertion #${index} references unknown endpoint "${assertion.endpoint}". ` +
              `Known endpoints: ${[...endpointIdByKey.keys()].join(', ') || '(none)'}`,
          );
        }
        return buildIrAssertion(scenarioSlug, index, endpointId, assertion);
      },
    );

    const harness: HarnessId =
      scenario.harness ?? parsed.harness ?? 'claude-code';

    return {
      id: scenarioId,
      name: scenario.name,
      prompt: scenario.prompt,
      harness,
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
  scenarioSlug: string,
  index: number,
  endpointId: string,
  assertion: z.infer<typeof assertionSchema>,
): IrAssertion {
  const id = `assertion.${scenarioSlug}.${index}`;
  if (assertion.kind === 'http.called') {
    const base: IrAssertion = {id, kind: 'http.called', endpointId};
    if (assertion.status !== undefined) {
      return {...base, status: assertion.status};
    }
    return base;
  }
  return {id, kind: 'http.notCalled', endpointId};
}
