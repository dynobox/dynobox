import type {IrAssertion} from '@dynobox/sdk/ir';

import type {AssertionResult} from './types.js';

type AssertionLike = {
  id?: unknown;
  type?: unknown;
};

type AssertionResultSource = {
  id: string;
  type: string;
};

export function failed(
  assertion: Pick<IrAssertion, 'id' | 'type'>,
  message: string,
): AssertionResult {
  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed: false,
    message,
  };
}

export function passed(
  assertion: AssertionResultSource,
  message: string,
  evidence?: unknown,
): AssertionResult {
  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed: true,
    message,
    ...(evidence === undefined ? {} : {evidence}),
  };
}

export function unsupportedAssertionResult(
  assertion: AssertionLike,
): AssertionResult {
  const assertionId =
    typeof assertion.id === 'string' ? assertion.id : 'unknown';
  const type = typeof assertion.type === 'string' ? assertion.type : 'unknown';

  return {
    assertionId,
    type,
    passed: false,
    message: `Assertion type "${type}" is not supported by this evaluator.`,
  };
}
