import {createAnyOfAssertion} from '../internal/brands.js';
import type {AnyOfAssertion, AnyOfBranchAssertion} from '../types/brands.js';

/**
 * Assert that at least one branch assertion passes.
 *
 * Every branch is evaluated on each run. When multiple branches pass, the
 * lowest-index branch is reported as the match.
 */
export function anyOf<K extends string>(
  steps: readonly AnyOfBranchAssertion<K>[],
): AnyOfAssertion<K> {
  return createAnyOfAssertion(steps);
}
