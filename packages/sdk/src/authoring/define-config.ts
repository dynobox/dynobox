import type {Endpoint} from '../types/brands.js';
import type {DynoboxConfig, ScenarioInput} from '../types/config.js';
import type {HarnessId} from '../types/harness.js';

type EndpointMap = Record<string, Endpoint>;

/**
 * For a tuple of scenario shapes, produce a parallel tuple where each
 * scenario's assertions are constrained to keys ∈ (global ∪ thatScenario.local).
 *
 * This is the type-level enforcement of the assertion-key invariant.
 */
type ConstrainScenarios<
  GE extends EndpointMap | undefined,
  S extends ReadonlyArray<ScenarioInput<string, EndpointMap>>,
> = {
  [I in keyof S]: ScenarioInput<
    | (GE extends EndpointMap ? keyof GE & string : never)
    | (S[I]['endpoints'] extends EndpointMap
        ? keyof S[I]['endpoints'] & string
        : never)
  >;
};

/**
 * Provides a typed passthrough for authoring Dynobox configs. The mapped
 * type over `scenarios` constrains each scenario's assertion endpoint keys
 * to keys present in (global ∪ that scenario's local) endpoints.
 *
 * @param config The config object authored by the user.
 * @returns The same config object, narrowed to `DynoboxConfig` for downstream use.
 */
export function defineConfig<
  const GE extends EndpointMap | undefined,
  const S extends ReadonlyArray<ScenarioInput<string, EndpointMap>>,
>(config: {
  name?: string;
  version?: string;
  harness?: HarnessId;
  setup?: string[];
  endpoints?: GE;
  scenarios: S & ConstrainScenarios<GE, S>;
}): DynoboxConfig {
  return config as unknown as DynoboxConfig;
}
