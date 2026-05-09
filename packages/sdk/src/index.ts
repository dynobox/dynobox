/**
 * Public authoring entrypoint for Dynobox config files.
 *
 * Runtime compiler and IR utilities intentionally live under
 * `@dynobox/sdk/compiler` and `@dynobox/sdk/ir` so user configs import a small,
 * stable helper surface.
 */

export {artifact} from './artifact/index.js';
export {defineConfig} from './authoring/define-config.js';
export {defineScenario} from './authoring/define-scenario.js';
export {dyno} from './dyno/index.js';
export {finalMessage} from './final-message/index.js';
export {http} from './http/index.js';
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
export {
  HARNESS_IDS,
  type HarnessId,
  type HarnessRunConfig,
} from './types/harness.js';
export {HTTP_METHODS, type HttpMethod} from './types/http-method.js';
