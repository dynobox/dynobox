import {createFinalMessageContainsAssertion} from '../internal/brands.js';
import type {FinalMessageContainsAssertion} from '../types/brands.js';

/** Authoring helpers for assertions against the extracted final response. */
export const finalMessage = {
  /** Assert that the final assistant message contains expected text. */
  contains(text: string): FinalMessageContainsAssertion {
    return createFinalMessageContainsAssertion(text);
  },
};
