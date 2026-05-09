import {createSequenceInOrderAssertion} from '../internal/brands.js';
import type {
  SequenceInOrderAssertion,
  ToolCalledAssertion,
} from '../types/brands.js';

/** Authoring helpers for ordered multi-step expectations. */
export const sequence = {
  /** Assert that positive tool-call steps happen in the provided order. */
  inOrder(steps: readonly ToolCalledAssertion[]): SequenceInOrderAssertion {
    return createSequenceInOrderAssertion(steps);
  },
};
