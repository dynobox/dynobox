import {createAnyOfAssertion} from '../internal/brands.js';
import type {AnyOfAssertion, AnyOfBranchAssertion} from '../types/brands.js';

/**
 * Assert that at least one branch assertion passes.
 *
 * Every branch is evaluated on each run. When multiple branches pass, the
 * lowest-index branch is reported as the match.
 */
export function anyOf(steps: readonly AnyOfBranchAssertion[]): AnyOfAssertion;
export function anyOf(steps: readonly AnyOfBranchAssertion[]): AnyOfAssertion {
  return createAnyOfAssertion(steps);
}
