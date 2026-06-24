import {createSequenceInOrderAssertion} from '../internal/brands.js';
import type {
  SequenceInOrderAssertion,
  SequenceStepAssertion,
} from '../types/brands.js';

/** Authoring helpers for ordered multi-step expectations. */
export const sequence = {
  /** Assert that positive tool-call steps happen in the provided order. */
  inOrder(steps: readonly SequenceStepAssertion[]): SequenceInOrderAssertion {
    return createSequenceInOrderAssertion(steps);
  },
};
