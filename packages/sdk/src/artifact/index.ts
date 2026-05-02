import {
  type ArtifactContainsAssertion,
  type ArtifactExistsAssertion,
  brandArtifactContains,
  brandArtifactExists,
} from '../types/brands.js';

export const artifact = {
  exists(path: string): ArtifactExistsAssertion {
    return brandArtifactExists(path);
  },

  contains(path: string, text: string): ArtifactContainsAssertion {
    return brandArtifactContains(path, text);
  },
};
