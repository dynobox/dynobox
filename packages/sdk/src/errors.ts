/**
 * Thrown by `compile` when a config is structurally valid but semantically
 * inconsistent (e.g. an assertion references an endpoint that does not
 * exist in the merged endpoint set for its scenario).
 */
export class DynoboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynoboxConfigError';
  }
}
