import type {z} from 'zod';

import {
  IR_VERSION,
  irAssertionSchema,
  irEndpointSchema,
  irHarnessConfigSchema,
  irScenarioSchema,
  irSchema,
} from './schema.js';

export {IR_VERSION};
export type IrVersion = typeof IR_VERSION;

export type IrEndpoint = z.infer<typeof irEndpointSchema>;
export type IrHarnessConfig = z.infer<typeof irHarnessConfigSchema>;
type BaseIrAssertion = z.infer<typeof irAssertionSchema>;
export type IrSequenceStep =
  | Omit<Extract<BaseIrAssertion, {kind: 'tool.called'}>, 'id' | 'label'>
  | Omit<Extract<BaseIrAssertion, {kind: 'command.called'}>, 'id' | 'label'>;
export type IrAssertionNode = Omit<
  Exclude<
    BaseIrAssertion,
    {kind: 'sequence.inOrder'} | {kind: 'anyOf'} | {kind: 'verify.command'}
  >,
  'id' | 'label'
>;
export type IrAnyOfAssertion = {
  id: string;
  label?: string;
  kind: 'anyOf';
  steps: IrAssertionNode[];
};
export type IrSequenceInOrderAssertion = Omit<
  Extract<BaseIrAssertion, {kind: 'sequence.inOrder'}>,
  'steps'
> & {steps: IrSequenceStep[]};
export type IrAssertion =
  | Exclude<BaseIrAssertion, {kind: 'sequence.inOrder'}>
  | IrSequenceInOrderAssertion
  | IrAnyOfAssertion;
type BaseIrScenario = z.infer<typeof irScenarioSchema>;
export type IrScenario = Omit<BaseIrScenario, 'assertions'> & {
  assertions: IrAssertion[];
};
export type Ir = Omit<z.infer<typeof irSchema>, 'scenarios'> & {
  scenarios: IrScenario[];
};

/** Attach an ID to a branch-level assertion node for evaluation or display. */
export function irAssertionFromNode(
  id: string,
  node: IrAssertionNode,
): IrAssertion {
  // Spreading a discriminated union does not preserve TS narrowing; the input
  // type already excludes composite assertion kinds allowed only at top level.
  return {id, ...node} as IrAssertion;
}
