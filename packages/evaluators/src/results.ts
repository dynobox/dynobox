import type {IrAssertion} from '@dynobox/sdk/ir';

import type {AssertionResult} from './types.js';

type AssertionLike = {
  id?: unknown;
  kind?: unknown;
};

export function failed(
  assertion: Pick<IrAssertion, 'id' | 'kind'>,
  message: string,
): AssertionResult {
  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message,
  };
}

export function unsupportedAssertionResult(
  assertion: AssertionLike,
): AssertionResult {
  const assertionId =
    typeof assertion.id === 'string' ? assertion.id : 'unknown';
  const kind = typeof assertion.kind === 'string' ? assertion.kind : 'unknown';

  return {
    assertionId,
    kind,
    passed: false,
    message: `Assertion kind "${kind}" is not supported by this evaluator.`,
  };
}
