import {createVerifyCommandAssertion} from '../internal/brands.js';
import type {
  VerifyCommandAssertion,
  VerifyCommandOptions,
} from '../types/brands.js';

/** Authoring helpers for post-harness verification commands. */
export const verify = {
  /** Assert that a verification command exits successfully. */
  succeeds(command: string): VerifyCommandAssertion {
    return createVerifyCommandAssertion(command, {exitCode: 0});
  },

  /** Assert that a verification command satisfies explicit output/exit checks. */
  command(command: string, opts: VerifyCommandOptions): VerifyCommandAssertion {
    return createVerifyCommandAssertion(command, opts);
  },
};
