import {
  createCommandCalledAssertion,
  createCommandNotCalledAssertion,
} from '../internal/brands.js';
import type {
  CommandCalledAssertion,
  CommandMatcher,
  CommandNotCalledAssertion,
} from '../types/brands.js';

/**
 * Assert that the harness should run a normalized command segment.
 *
 * @experimental Matching behavior and matcher options may change.
 */
function called(
  executable: string,
  matcher?: CommandMatcher,
): CommandCalledAssertion {
  return createCommandCalledAssertion(executable, matcher);
}

/**
 * Assert that the harness should not run a normalized command segment.
 *
 * @experimental Matching behavior and matcher options may change.
 */
function notCalled(
  executable: string,
  matcher?: CommandMatcher,
): CommandNotCalledAssertion {
  return createCommandNotCalledAssertion(executable, matcher);
}

/**
 * Authoring helpers for normalized observed command assertions.
 *
 * @experimental Matching behavior and matcher options may change.
 */
export const command = {
  called,
  notCalled,
};
