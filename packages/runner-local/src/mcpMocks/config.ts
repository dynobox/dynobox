import {readFile} from 'node:fs/promises';

import {parse, type ParseError} from 'jsonc-parser';

import {isRecord, type JsonObject} from '../harnesses/parsing.js';
import {McpHarnessError} from './errors.js';

/** Read optional native configuration without evaluating or connecting to it. */
export async function readMcpJsonConfig(
  path: string,
  messages: {read?: string; parse: string; allowEmpty?: boolean},
): Promise<JsonObject> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (messages.read === undefined) throw error;
    throw new McpHarnessError('configuration_failed', messages.read);
  }
  if (messages.allowEmpty && !source.trim()) return {};
  return parseMcpJsonConfig(source, messages.parse);
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
