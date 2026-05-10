import {createSkillInvokedAssertion} from '../internal/brands.js';
import type {SkillInvokedAssertion} from '../types/brands.js';

/** Assert that the harness should load a named skill's instruction file. */
function invoked(skill: string): SkillInvokedAssertion {
  return createSkillInvokedAssertion(skill);
}

/** Authoring helpers for skill-use assertions. */
export const skill = {
  invoked,
};
