import {createAnyOfAssertion} from '../internal/brands.js';
import type {AnyOfAssertion, AnyOfBranchAssertion} from '../types/brands.js';

/** Assert that at least one branch assertion passes. */
export function anyOf(steps: readonly AnyOfBranchAssertion[]): AnyOfAssertion;
export function anyOf(steps: readonly AnyOfBranchAssertion[]): AnyOfAssertion {
  return createAnyOfAssertion(steps);
}
