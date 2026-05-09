import {
  createArtifactContainsAssertion,
  createArtifactExistsAssertion,
} from '../internal/brands.js';
import type {
  ArtifactContainsAssertion,
  ArtifactExistsAssertion,
} from '../types/brands.js';

/** Authoring helpers for assertions against files in the scenario workdir. */
export const artifact = {
  /** Assert that a path exists after the harness runs. */
  exists(path: string): ArtifactExistsAssertion {
    return createArtifactExistsAssertion(path);
  },

  /** Assert that a file contains expected text after the harness runs. */
  contains(path: string, text: string): ArtifactContainsAssertion {
    return createArtifactContainsAssertion(path, text);
  },
};
