export const version = '0.0.1';

export {defineConfig} from './authoring/define-config.js';
export {defineScenario} from './authoring/define-scenario.js';
export {DynoboxConfigError} from './errors.js';
export {http} from './http/index.js';
export {compile} from './ir/compile.js';
export {slugify} from './ir/ids.js';
export {
  irAssertionSchema,
  irEndpointSchema,
  irScenarioSchema,
  irSchema,
  irVersionSchema,
} from './ir/schema.js';
export {
  type Ir,
  IR_VERSION,
  type IrAssertion,
  type IrEndpoint,
  type IrScenario,
  type IrVersion,
} from './ir/types.js';
export {configSchema} from './schema/config-schema.js';
export {resolveConfigModule} from './schema/resolve-module.js';
export type {
  Assertion,
  CalledAssertion,
  Endpoint,
  NotCalledAssertion,
} from './types/brands.js';
export type {DynoboxConfig, ScenarioInput} from './types/config.js';
export type {EndpointSpec} from './types/endpoint-spec.js';
export {HARNESS_IDS, type HarnessId} from './types/harness.js';
export {HTTP_METHODS, type HttpMethod} from './types/http-method.js';
