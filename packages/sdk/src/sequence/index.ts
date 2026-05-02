import {
  brandSequenceInOrder,
  type SequenceInOrderAssertion,
  type ToolCalledAssertion,
} from '../types/brands.js';

export const sequence = {
  inOrder(steps: readonly ToolCalledAssertion[]): SequenceInOrderAssertion {
    return brandSequenceInOrder(steps);
  },
};
