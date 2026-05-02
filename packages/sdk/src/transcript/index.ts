import {
  brandTranscriptContains,
  type TranscriptContainsAssertion,
} from '../types/brands.js';

export const transcript = {
  contains(text: string): TranscriptContainsAssertion {
    return brandTranscriptContains(text);
  },
};
