import {
  createArtifactContainsAssertion,
  createArtifactExistsAssertion,
  createArtifactNotExistsAssertion,
  createArtifactUnchangedAssertion,
} from '../internal/brands.js';
import type {
  ArtifactContainsAssertion,
  ArtifactExistsAssertion,
  ArtifactNotExistsAssertion,
  ArtifactUnchangedAssertion,
} from '../types/brands.js';

/** Authoring helpers for assertions against files in the scenario workdir. */
export const artifact = {
  /** Assert that a path exists after the harness runs. */
  exists(path: string): ArtifactExistsAssertion {
    return createArtifactExistsAssertion(path);
  },

  /** Assert that a path is absent after the harness runs. */
  notExists(path: string): ArtifactNotExistsAssertion {
    return createArtifactNotExistsAssertion(path);
  },

  /** Assert that a file contains expected text after the harness runs. */
  contains(path: string, text: string): ArtifactContainsAssertion {
    return createArtifactContainsAssertion(path, text);
  },

  /**
   * Assert that a regular file's raw bytes match the post-setup baseline
   * captured before the harness starts.
   */
  unchanged(path: string): ArtifactUnchangedAssertion {
    return createArtifactUnchangedAssertion(path);
  },
};
