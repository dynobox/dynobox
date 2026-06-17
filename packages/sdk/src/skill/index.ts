import {createSkillReferencedAssertion} from '../internal/brands.js';
import type {SkillReferencedAssertion} from '../types/brands.js';

/** Assert that observed harness events referenced a named skill's instruction file. */
function referenced(skill: string): SkillReferencedAssertion {
  return createSkillReferencedAssertion(skill);
}

/** Authoring helpers for skill reference assertions. */
export const skill = {
  referenced,
};
