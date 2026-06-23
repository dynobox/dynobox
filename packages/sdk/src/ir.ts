/** Canonical IR schemas and types consumed by runners and evaluators. */

export {
  irAssertionSchema,
  irEndpointSchema,
  irHarnessConfigSchema,
  irScenarioSchema,
  irSchema,
  irVersionSchema,
} from './ir/schema.js';
export {
  type Ir,
  IR_VERSION,
  type IrAssertion,
  type IrAssertionNode,
  irAssertionFromNode,
  type IrEndpoint,
  type IrHarnessConfig,
  type IrScenario,
  type IrVersion,
} from './ir/types.js';
