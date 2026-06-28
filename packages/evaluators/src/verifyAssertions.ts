import type {IrAssertion} from '@dynobox/sdk/ir';

import {passed} from './results.js';
import {describeShellMatcher, shellCommandMatches} from './shellMatcher.js';
import type {AssertionResult, VerifyCommandResult} from './types.js';

type VerifyCommandAssertion = Extract<IrAssertion, {type: 'verify.command'}>;

export function evaluateVerifyCommandAssertion(
  assertion: VerifyCommandAssertion,
  results: readonly VerifyCommandResult[] | undefined,
): AssertionResult {
  const result = results?.find(
    (candidate) => candidate.assertionId === assertion.id,
  );

  if (result === undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: `Verification command "${assertion.command}" was not run.`,
    };
  }

  if (
    assertion.exitCode === undefined &&
    assertion.stdout === undefined &&
    assertion.stderr === undefined
  ) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message:
        'Verification command assertions must specify exitCode, stdout, or stderr.',
      evidence: result,
    };
  }

  const failures: string[] = [];
  if (
    assertion.exitCode !== undefined &&
    result.exitCode !== assertion.exitCode
  ) {
    failures.push(
      `exit code ${result.exitCode}, expected ${assertion.exitCode}`,
    );
  }
  if (assertion.stdout !== undefined) {
    const matched = shellCommandMatches(result.stdout, assertion.stdout);
    if (!matched.passed) {
      failures.push(
        matched.error ??
          `stdout did not match ${describeShellMatcher(assertion.stdout)}`,
      );
    }
  }
  if (assertion.stderr !== undefined) {
    const matched = shellCommandMatches(result.stderr, assertion.stderr);
    if (!matched.passed) {
      failures.push(
        matched.error ??
          `stderr did not match ${describeShellMatcher(assertion.stderr)}`,
      );
    }
  }

  if (failures.length === 0) {
    return passed(
      assertion,
      `Verification command "${assertion.command}" passed.`,
      result,
    );
  }

  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed: false,
    message: `Verification command "${assertion.command}" failed: ${failures.join('; ')}.`,
    evidence: result,
  };
}
