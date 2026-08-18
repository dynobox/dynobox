import {realpathSync} from 'node:fs';

import type {PermissionMode} from '@dynobox/sdk';

import {
  createToolEvent,
  isRecord,
  jsonLines,
  type JsonObject,
  parseJsonObjectLine,
  textFromContent,
} from './parsing.js';
import {runStreamingHarness} from './runStreamingHarness.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './types.js';
import {createVersionProbe} from './version.js';

export type CursorHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

export type CursorParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
  errorMessage: string | undefined;
  terminalFailure: boolean;
};

export type CursorParsedLine = {
  toolEvents: ToolEvent[];
  callId?: string;
  finalMessage?: string;
  errorMessage?: string;
  terminalFailure?: boolean;
};

export class CursorHarness implements Harness {
  readonly id = 'cursor' as const;

  readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: CursorHarnessOptions = {}) {
    this.executable = options.executable ?? 'cursor-agent';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const toolInputs = new Map<string, unknown>();
    const workDir = realpathSync(input.workDir);
    return runStreamingHarness({
      executable: this.executable,
      args: buildCursorArgs(
        workDir,
        input.prompt,
        this.extraArgs,
        input.model,
        input.permissionMode,
      ),
      input,
      cwd: workDir,
      stdin: 'ignore',
      parseLine: (line, lineNumber) =>
        parseCursorJsonLine(line, lineNumber, toolInputs),
      shouldEmit: createCursorToolEventDeduper(),
    });
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const parsed = parseCursorJson(raw.stdout);
    return {
      exitCode: raw.exitCode === 0 && parsed.terminalFailure ? 1 : raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: parsed.finalMessage,
      toolEvents: parsed.toolEvents,
      ...(parsed.errorMessage === undefined
        ? {}
        : {errorMessage: parsed.errorMessage}),
    };
  }
}

export function buildCursorArgs(
  workDir: string,
  prompt: string,
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--trust',
    '--workspace',
    workDir,
    ...cursorPermissionArgs(permissionMode),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
    prompt,
  ];
}

function cursorPermissionArgs(
  permissionMode: PermissionMode | undefined,
): string[] {
  // Print mode only persists writes with --force; sandbox-off stays dangerous-only.
  if (permissionMode === 'dangerous') {
    return ['--force', '--sandbox', 'disabled'];
  }
  return ['--force'];
}

export function parseCursorJson(stdout: string): CursorParsedOutput {
  let finalMessage: string | undefined;
  let errorMessage: string | undefined;
  let terminalFailure = false;
  const toolEvents: ToolEvent[] = [];
  const toolInputs = new Map<string, unknown>();
  const seenCallIds = new Set<string>();

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseCursorJsonLine(line, lineNumber, toolInputs);
    if (parsed.callId === undefined || !seenCallIds.has(parsed.callId)) {
      toolEvents.push(...parsed.toolEvents);
      if (parsed.callId !== undefined) seenCallIds.add(parsed.callId);
    }
    if (parsed.finalMessage !== undefined) finalMessage = parsed.finalMessage;
    if (parsed.errorMessage !== undefined) errorMessage = parsed.errorMessage;
    if (parsed.terminalFailure === true) terminalFailure = true;
  }

  return {finalMessage, toolEvents, errorMessage, terminalFailure};
}

export function parseCursorJsonLine(
  line: string,
  lineNumber = 1,
  toolInputs = new Map<string, unknown>(),
): CursorParsedLine {
  const event = parseJsonObjectLine(line, lineNumber, 'Cursor JSON line');

  if (event.type === 'tool_call') {
    return parseToolCall(event, toolInputs);
  }

  if (event.type === 'result') {
    return parseResultEvent(event);
  }

  if (event.type === 'assistant') {
    const finalMessage = parseAssistantMessage(event);
    return {
      toolEvents: [],
      ...(finalMessage === undefined ? {} : {finalMessage}),
    };
  }

  return {toolEvents: []};
}

function parseToolCall(
  event: JsonObject,
  toolInputs: Map<string, unknown>,
): CursorParsedLine {
  const toolCall = isRecord(event.tool_call) ? event.tool_call : undefined;
  if (toolCall === undefined) return {toolEvents: []};

  const parsed = parseToolCallPayload(toolCall);
  if (parsed === undefined) return {toolEvents: []};

  const callId = typeof event.call_id === 'string' ? event.call_id : undefined;
  if (event.subtype === 'started') {
    if (callId !== undefined) toolInputs.set(callId, parsed.args);
    return {toolEvents: []};
  }

  const input =
    parsed.args ??
    (callId === undefined ? undefined : toolInputs.get(callId)) ??
    {};
  if (callId !== undefined) toolInputs.delete(callId);

  return {
    toolEvents: [
      createToolEvent(
        parsed.rawName,
        input,
        parsed.status,
        parsed.message,
        kindOverrideFor(parsed.rawName),
      ),
    ],
    ...(callId === undefined ? {} : {callId}),
  };
}

type ParsedToolCall = {
  rawName: string;
  args: unknown;
  status: ToolEvent['status'] | undefined;
  message: string | undefined;
};

function parseToolCallPayload(
  toolCall: JsonObject,
): ParsedToolCall | undefined {
  const functionCall = isRecord(toolCall.function)
    ? toolCall.function
    : undefined;
  if (functionCall !== undefined && typeof functionCall.name === 'string') {
    return {
      rawName: functionCall.name,
      args: parseArguments(functionCall.arguments ?? functionCall.args),
      status: parseToolStatus(functionCall),
      message: parseToolMessage(functionCall),
    };
  }

  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith('ToolCall') || !isRecord(value)) continue;
    return {
      rawName: toolNameFromKey(key),
      args: value.args,
      status: parseToolStatus(value),
      message: parseToolMessage(value),
    };
  }

  return undefined;
}

function toolNameFromKey(key: string): string {
  const name = key.endsWith('ToolCall')
    ? key.slice(0, -'ToolCall'.length)
    : key;
  if (name.length === 0) return key;
  return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseToolStatus(
  candidate: JsonObject,
): ToolEvent['status'] | undefined {
  const result = isRecord(candidate.result) ? candidate.result : undefined;
  if (result === undefined) return undefined;

  if (hasFailureResult(result)) return 'failure';

  const success = isRecord(result.success) ? result.success : undefined;
  if (success !== undefined) {
    const exitCode = success.exitCode ?? success.exit_code;
    if (typeof exitCode === 'number') {
      return exitCode === 0 ? 'success' : 'failure';
    }
    return 'success';
  }

  if ('success' in result && result.success != null) return 'success';
  return undefined;
}

function hasFailureResult(result: JsonObject): boolean {
  return (
    result.success === false ||
    result.error != null ||
    result.failure != null ||
    result.rejected != null
  );
}

function parseToolMessage(candidate: JsonObject): string | undefined {
  const result = isRecord(candidate.result) ? candidate.result : undefined;
  if (result === undefined) return undefined;

  const rejected = isRecord(result.rejected) ? result.rejected : undefined;
  const rejectedReason =
    typeof rejected?.reason === 'string' ? rejected.reason : undefined;
  const failureMessage =
    stringFromUnknown(result.error) ??
    stringFromUnknown(result.failure) ??
    rejectedReason;
  if (failureMessage !== undefined) return failureMessage;

  const success = isRecord(result.success) ? result.success : undefined;
  if (success === undefined) return undefined;
  const exitCode = success.exitCode ?? success.exit_code;
  if (typeof exitCode !== 'number' || exitCode === 0) return undefined;
  return stringFromUnknown(success.stderr) ?? stringFromUnknown(success.stdout);
}

function parseResultEvent(event: JsonObject): CursorParsedLine {
  const finalMessage =
    typeof event.result === 'string' ? event.result : undefined;
  const terminalFailure = event.is_error === true || event.subtype === 'error';
  const errorMessage = terminalFailure
    ? (finalMessage ?? 'Cursor run failed')
    : undefined;

  return {
    toolEvents: [],
    ...(finalMessage === undefined ? {} : {finalMessage}),
    ...(errorMessage === undefined ? {} : {errorMessage}),
    ...(terminalFailure ? {terminalFailure: true} : {}),
  };
}

function parseAssistantMessage(event: JsonObject): string | undefined {
  const message = isRecord(event.message) ? event.message : undefined;
  return textFromContent(message?.content) ?? textFromContent(event.content);
}

function kindOverrideFor(rawName: string): ToolEvent['kind'] | undefined {
  const normalized = rawName.toLowerCase();
  if (
    normalized === 'mcp' ||
    normalized.startsWith('mcp__') ||
    normalized.startsWith('mcp_') ||
    normalized.startsWith('mcp-')
  ) {
    return 'mcp';
  }
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const message = value.trim();
    return message.length === 0 ? undefined : message;
  }
  if (!isRecord(value)) return undefined;

  for (const key of ['message', 'reason', 'detail', 'error', 'content']) {
    const message = stringFromUnknown(value[key]);
    if (message !== undefined) return message;
  }
  return undefined;
}

function createCursorToolEventDeduper(): (
  event: ToolEvent,
  line: string,
) => boolean {
  const seenCallIds = new Set<string>();

  return (_event, line) => {
    const callId = extractCallId(line);
    if (callId === undefined) return true;
    if (seenCallIds.has(callId)) return false;
    seenCallIds.add(callId);
    return true;
  };
}

function extractCallId(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed) && typeof parsed.call_id === 'string') {
      return parsed.call_id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
