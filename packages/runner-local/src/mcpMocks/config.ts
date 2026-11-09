import {readFile} from 'node:fs/promises';

import {parse, type ParseError} from 'jsonc-parser';

import {isRecord, type JsonObject} from '../harnesses/parsing.js';
import {McpHarnessError} from './errors.js';

/**
 * Read optional native configuration without evaluating or connecting to it.
 * Without `read`, read failures other than a missing file are rethrown as is.
 */
export async function readMcpJsonConfig(
  path: string,
  options: {read?: string; parse: string; allowEmpty?: boolean},
): Promise<JsonObject> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (options.read === undefined) throw error;
    throw new McpHarnessError('configuration_failed', options.read);
  }
  if (options.allowEmpty && !source.trim()) return {};
  return parseMcpJsonConfig(source, options.parse);
}

export function parseMcpJsonConfig(
  source: string,
  message: string,
): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, {allowTrailingComma: true});
  if (errors.length || !isRecord(value))
    throw new McpHarnessError('configuration_failed', message);
  return value;
}
