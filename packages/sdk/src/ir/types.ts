import type {z} from 'zod';

import {
  IR_VERSION,
  irAssertionSchema,
  irEndpointSchema,
  irScenarioSchema,
  irSchema,
} from './schema.js';

export {IR_VERSION};
export type IrVersion = typeof IR_VERSION;

export type IrEndpoint = z.infer<typeof irEndpointSchema>;
export type IrAssertion = z.infer<typeof irAssertionSchema>;
export type IrScenario = z.infer<typeof irScenarioSchema>;
export type Ir = z.infer<typeof irSchema>;
