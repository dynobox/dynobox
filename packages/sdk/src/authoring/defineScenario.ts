import type {Endpoint} from '../types/brands.js';
import type {ScenarioInput} from '../types/config.js';

type EndpointMap = Record<string, Endpoint>;
type EmptyEndpointMap = Record<string, never>;

/**
 * Provides a typed passthrough for authoring a single scenario in
 * isolation. When the scenario references endpoints declared at the config
 * root, pass their key union as the `Globals` type parameter.
 *
 * @param scenario The scenario object authored by the user.
 * @returns The same scenario object, narrowed to `ScenarioInput`.
 */
export function defineScenario<
  Globals extends string = never,
  const E extends EndpointMap = EmptyEndpointMap,
>(scenario: ScenarioInput<Globals | (keyof E & string), E>): ScenarioInput {
  return scenario;
}
