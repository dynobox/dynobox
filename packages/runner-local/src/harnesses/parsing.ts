import {normalizeToolKind} from './toolEvents.js';
import type {ShellToolEvent, ToolEvent} from './types.js';

export type JsonObject = Record<string, unknown>;

export function* jsonLines(
  stdout: string,
): Generator<{line: string; lineNumber: number}> {
  const lines = stdout.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    yield {line, lineNumber: index + 1};
  }
}

export function parseJsonObjectLine(
  line: string,
  lineNumber: number,
  label: string,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} ${lineNumber}: ${message}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Failed to parse ${label} ${lineNumber}: expected an object.`,
    );
  }
  return parsed;
}

export function createToolEvent(
  rawName: string,
  input: unknown,
  status: ToolEvent['status'] | undefined = undefined,
  message: string | undefined = undefined,
): ToolEvent {
  const kind = normalizeToolKind(rawName);
  const base: ToolEvent = {
    kind,
    rawName,
    input,
    ...(status === undefined ? {} : {status}),
    ...(message === undefined ? {} : {message}),
  };

  const command = shellCommand(input);
  if (kind === 'shell' && command !== undefined) {
    const shellEvent: ShellToolEvent = {...base, kind: 'shell', command};
    return shellEvent;
  }

  return base;
}

export function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((part) => {
      if (!isRecord(part)) return undefined;
      return typeof part.text === 'string' ? part.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join('');

  return text.length === 0 ? undefined : text;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.command === 'string') return input.command;
  return typeof input.cmd === 'string' ? input.cmd : undefined;
}
