import {passed} from './results.js';
import type {AssertionResult} from './types.js';

export function evaluateTextContains(input: {
  assertionId: string;
  kind: string;
  label: string;
  actual: string | undefined;
  expected: string;
}): AssertionResult {
  if (input.actual === undefined) {
    return {
      assertionId: input.assertionId,
      kind: input.kind,
      passed: false,
      message: `Expected ${input.label} to contain "${input.expected}", but ${input.label} text is unavailable.`,
    };
  }

  if (input.actual.includes(input.expected)) {
    return passed(
      {id: input.assertionId, kind: input.kind},
      `Observed ${input.label} containing expected text.`,
    );
  }

  return {
    assertionId: input.assertionId,
    kind: input.kind,
    passed: false,
    message: `Expected ${input.label} to contain "${input.expected}".`,
  };
}
