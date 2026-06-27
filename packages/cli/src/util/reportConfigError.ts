import type {OutputWriter} from '../program/execute.js';

/**
 * Run a config validator and render a config-error stderr block when it throws.
 */
export function reportConfigError<T>(
  inputLabel: string,
  writeStderr: OutputWriter,
  render: (inputLabel: string, message: string) => string,
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(render(inputLabel, message));
    throw error;
  }
}
