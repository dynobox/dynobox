import {
  brandFinalMessageContains,
  type FinalMessageContainsAssertion,
} from '../types/brands.js';

export const finalMessage = {
  contains(text: string): FinalMessageContainsAssertion {
    return brandFinalMessageContains(text);
  },
};
