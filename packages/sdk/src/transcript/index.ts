import {createTranscriptContainsAssertion} from '../internal/brands.js';
import type {TranscriptContainsAssertion} from '../types/brands.js';

/** Authoring helpers for assertions against the full harness transcript. */
export const transcript = {
  /** Assert that the transcript contains expected text. */
  contains(text: string): TranscriptContainsAssertion {
    return createTranscriptContainsAssertion(text);
  },
};
