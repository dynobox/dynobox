export const version = '0.0.1';

export {artifact} from './artifact/index.js';
export {defineConfig} from './authoring/define-config.js';
export {defineScenario} from './authoring/define-scenario.js';
export {DynoboxConfigError} from './errors.js';
export {finalMessage} from './final-message/index.js';
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
export {sequence} from './sequence/index.js';
export {tool} from './tool/index.js';
export {transcript} from './transcript/index.js';
export type {
  ArtifactContainsAssertion,
  ArtifactExistsAssertion,
  Assertion,
  CalledAssertion,
  Endpoint,
  FinalMessageContainsAssertion,
  NotCalledAssertion,
  SequenceInOrderAssertion,
  ShellToolMatcher,
  ToolCalledAssertion,
  ToolKind,
  ToolNotCalledAssertion,
  TranscriptContainsAssertion,
} from './types/brands.js';
export type {DynoboxConfig, ScenarioInput} from './types/config.js';
export type {EndpointSpec} from './types/endpoint-spec.js';
export {HARNESS_IDS, type HarnessId} from './types/harness.js';
export {HTTP_METHODS, type HttpMethod} from './types/http-method.js';
