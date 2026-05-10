/**
 * Load a `*.dyno.yaml` file as the same plain JS object shape that an
 * authored TypeScript config produces after the SDK's brand-helper calls
 * have run. The Zod schema in `@dynobox/sdk/compiler` accepts plain
 * objects with the discriminated `kind` field, so YAML configs flow
 * through the existing `compile()` pipeline unchanged.
 *
 * Parse errors are rewritten to include the file path plus a `line:column`
 * pointer so YAML authors can find the offending node quickly.
 */

import {readFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';

import {parse, YAMLParseError} from 'yaml';

/**
 * Thrown when a YAML dyno file fails to parse. Carries the file path plus
 * a pre-formatted message so the runCommand error renderer can surface it
 * the same way it surfaces TS load failures.
 */
export class YamlDynoParseError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'YamlDynoParseError';
  }
}

/**
 * Read and parse a YAML dyno file.
 *
 * @returns A `{default: <parsed>}` shape so `resolveConfigModule` from the
 *   SDK can unwrap it identically to a `tsx`-loaded ESM module.
 */
export async function loadYamlDyno(
  filePath: string,
): Promise<{default: unknown}> {
  const absolute = resolve(filePath);
  const source = await readFile(absolute, 'utf8');

  try {
    const parsed: unknown = parse(source, {prettyErrors: true});
    return {default: parsed};
  } catch (error) {
    throw new YamlDynoParseError(
      absolute,
      formatYamlError(error, absolute),
      error,
    );
  }
}

function formatYamlError(error: unknown, filePath: string): string {
  if (error instanceof YAMLParseError) {
    const display = relative(process.cwd(), filePath) || filePath;
    const linePos = error.linePos?.[0];
    const at = linePos === undefined ? '' : `:${linePos.line}:${linePos.col}`;
    return `${display}${at}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
