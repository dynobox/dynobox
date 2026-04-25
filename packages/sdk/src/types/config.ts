import type {Assertion, Endpoint} from './brands.js';
import type {HarnessId} from './harness.js';

/**
 * The author-facing scenario shape.
 *
 * Generic over:
 * - `EKeys`: the union of endpoint keys that assertions in this scenario
 *   may reference. `defineConfig` widens this to (global ∪ local) per
 *   scenario; `defineScenario` widens it to (declared globals ∪ local).
 * - `E`: the concrete endpoint map. Helpers capture this so `keyof E &
 *   string` produces the local key union.
 *
 * Defaults make `ScenarioInput` (no type args) the runtime/storage shape.
 */
export type ScenarioInput<
  EKeys extends string = string,
  E extends Record<string, Endpoint> = Record<string, Endpoint>,
> = {
  name: string;
  prompt: string;
  harness?: HarnessId;
  endpoints?: E;
  assertions?: ReadonlyArray<Assertion<EKeys>>;
};

/**
 * The runtime shape of an authored Dynobox config. Authors typically reach
 * this type indirectly via `defineConfig`, which adds per-scenario key
 * inference on top.
 */
export type DynoboxConfig = {
  name?: string;
  version?: string;
  harness?: HarnessId;
  endpoints?: Record<string, Endpoint>;
  scenarios: ScenarioInput[];
};
