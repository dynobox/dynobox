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
  irAssertionFromNode,
  type IrAssertionNode,
  type IrEndpoint,
  type IrHarnessConfig,
  type IrScenario,
  type IrVersion,
} from './ir/types.js';
export {mcpJsonObjectSchema, mcpMocksSchema} from './schema/mcpMocks.js';
export type {
  McpCallCategory,
  McpCallRecord,
  McpMockFailure,
  McpObservation,
} from './types/mcp.js';
