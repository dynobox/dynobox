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
  type IrScenarioUser,
  type IrVersion,
} from './ir/types.js';
export {httpMockResponseSchema, httpMocksSchema} from './schema/httpMocks.js';
export {mcpJsonObjectSchema, mcpMocksSchema} from './schema/mcpMocks.js';
export {
  DEFAULT_USER_HARNESS,
  DEFAULT_USER_MAX_TURNS,
  irScenarioUserSchema,
  MAX_USER_TURNS,
} from './schema/user.js';
export type {
  McpCallCategory,
  McpCallRecord,
  McpMockFailure,
  McpObservation,
} from './types/mcp.js';
