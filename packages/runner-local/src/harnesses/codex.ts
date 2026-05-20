import type {PermissionMode} from '@dynobox/sdk';
import {execa} from 'execa';
import {realpathSync} from 'fs';

import {normalizeToolKind} from './toolEvents.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './types.js';

export type CodexHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

type JsonObject = Record<string, unknown>;

export type CodexParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
};

export type CodexParsedLine = {
  toolEvents: ToolEvent[];
  finalMessage?: string;
};

export class CodexHarness implements Harness {
  readonly id = 'codex' as const;

  private readonly executable: string;
  private readonly extraArgs: readonly string[];

  constructor(options: CodexHarnessOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.extraArgs = options.extraArgs ?? [];
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const options = {
      cwd: realpathSync(input.workDir),
      env: {...process.env, ...input.env},
      reject: false,
      stdin: 'ignore' as const,
      ...(input.timeoutMs === undefined ? {} : {timeout: input.timeoutMs}),
    };

    const subprocess = execa(
      this.executable,
      buildCodexArgs(
        input.prompt,
        this.extraArgs,
        input.model,
        input.permissionMode,
      ),
      options,
    );
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const streamParser = new CodexToolEventStream((toolEvent) => {
      input.onToolEvent?.(toolEvent);
    });

    subprocess.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      streamParser.write(text);
    });
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    const result = await subprocess;
    streamParser.flush();
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    return {
      exitCode: result.exitCode ?? 1,
      stdout: stdout.length === 0 ? stdoutChunks.join('') : stdout,
      stderr: stderr.length === 0 ? stderrChunks.join('') : stderr,
      durationMs: result.durationMs,
    };
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const parsed = parseCodexJson(raw.stdout);
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: parsed.finalMessage,
      toolEvents: parsed.toolEvents,
    };
  }
}

export function buildCodexArgs(
  prompt: string,
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
): string[] {
  return [
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    ...codexPermissionArgs(permissionMode),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
    prompt,
  ];
}

function codexPermissionArgs(
  permissionMode: PermissionMode | undefined,
): string[] {
  if (permissionMode !== 'dangerous') return [];
  return ['--sandbox', 'danger-full-access', '-c', 'approval_policy="never"'];
}

export function parseCodexJson(stdout: string): CodexParsedOutput {
  let finalMessage: string | undefined;
  const toolEvents: ToolEvent[] = [];

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseCodexJsonLine(line, lineNumber);
    toolEvents.push(...parsed.toolEvents);

    if (parsed.finalMessage !== undefined) {
      finalMessage = parsed.finalMessage;
    }
  }

  return {finalMessage, toolEvents};
}

export function parseCodexJsonLine(
  line: string,
  lineNumber = 1,
): CodexParsedLine {
  const event = parseJsonObjectLine(line, lineNumber);
  const toolEvents = parseToolEvents(event);
  const finalMessage = parseFinalMessage(event);

  return {
    toolEvents,
    ...(finalMessage === undefined ? {} : {finalMessage}),
  };
}

class CodexToolEventStream {
  private buffer = '';
  private lineNumber = 0;
  private seenItemIds = new Set<string>();

  constructor(private readonly onToolEvent: (event: ToolEvent) => void) {}

  write(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.search(/\r?\n/);
      if (newlineIndex === -1) return;

      const line = this.buffer.slice(0, newlineIndex);
      const newlineLength =
        this.buffer[newlineIndex] === '\r' &&
        this.buffer[newlineIndex + 1] === '\n'
          ? 2
          : 1;
      this.buffer = this.buffer.slice(newlineIndex + newlineLength);
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length === 0) return;
    this.parseLine(this.buffer);
    this.buffer = '';
  }

  private parseLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;

    this.lineNumber += 1;
    try {
      const parsed = parseCodexJsonLine(line, this.lineNumber);
      const itemId = this.extractItemId(line);
      for (const toolEvent of parsed.toolEvents) {
        if (!this.shouldEmit(toolEvent, itemId)) continue;
        this.onToolEvent(toolEvent);
      }
    } catch {
      // Ignore parse errors during streaming - final extraction will report malformed lines with precise line number.
    }
  }

  private extractItemId(line: string): string | undefined {
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && isRecord(parsed.item)) {
        return typeof parsed.item.id === 'string' ? parsed.item.id : undefined;
      }
    } catch {
      // Ignore parse errors - return undefined gracefully.
    }
    return undefined;
  }

  private shouldEmit(
    toolEvent: ToolEvent,
    itemId: string | undefined,
  ): boolean {
    if (typeof itemId !== 'string') return true;
    if (this.seenItemIds.has(itemId)) return false;
    this.seenItemIds.add(itemId);
    return true;
  }
}

function* jsonLines(
  stdout: string,
): Generator<{line: string; lineNumber: number}> {
  const lines = stdout.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    yield {line, lineNumber: index + 1};
  }
}

function parseJsonObjectLine(line: string, lineNumber: number): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse Codex JSON line ${lineNumber}: ${message}`,
      {
        cause: error,
      },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Failed to parse Codex JSON line ${lineNumber}: expected an object.`,
    );
  }
  return parsed;
}

function parseToolEvents(event: JsonObject): ToolEvent[] {
  if (event.type !== 'item.completed') return [];
  const item = isRecord(event.item) ? event.item : undefined;
  const toolEvent = parseToolEvent(item ?? event, event);
  return toolEvent === undefined ? [] : [toolEvent];
}

function parseToolEvent(
  candidate: JsonObject,
  event: JsonObject,
): ToolEvent | undefined {
  const command = parseCommand(candidate);
  if (command !== undefined) {
    return createToolEvent(
      parseRawToolName(candidate) ?? 'shell',
      {command},
      parseStatus(candidate, event),
      parseFailureMessage(candidate, event),
    );
  }

  const rawName = parseRawToolName(candidate);
  if (rawName === undefined) return undefined;

  return createToolEvent(
    rawName,
    parseToolInput(candidate),
    parseStatus(candidate, event),
    parseFailureMessage(candidate, event),
  );
}

function parseRawToolName(candidate: JsonObject): string | undefined {
  for (const key of ['name', 'tool_name', 'toolName', 'type']) {
    const value = candidate[key];
    if (typeof value !== 'string') continue;
    if (key === 'type') {
      if (value.startsWith('mcp__') || isKnownToolType(value)) return value;
      continue;
    }
    if (isToolLikeName(value)) return value;
  }
  return undefined;
}

function isKnownToolType(value: string): boolean {
  return [
    'apply_patch',
    'bash',
    'command_execution',
    'edit_file',
    'function_call',
    'grep',
    'local_shell_call',
    'read_file',
    'search_files',
    'shell',
    'tool_call',
    'web_fetch',
    'web_search',
    'write_file',
  ].includes(value);
}

function isToolLikeName(value: string): boolean {
  return ![
    'agent_message',
    'assistant_message',
    'message',
    'reasoning',
    'turn.completed',
    'turn.failed',
  ].includes(value);
}

function parseToolInput(candidate: JsonObject): unknown {
  if ('input' in candidate) return candidate.input;
  if ('tool_input' in candidate) return candidate.tool_input;
  if ('arguments' in candidate) return parseArguments(candidate.arguments);
  return candidate;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCommand(candidate: JsonObject): string | undefined {
  for (const key of ['command', 'cmd']) {
    const value = candidate[key];
    if (typeof value === 'string') return value;
  }

  const input = isRecord(candidate.input) ? candidate.input : undefined;
  if (typeof input?.command === 'string') return input.command;
  if (typeof input?.cmd === 'string') return input.cmd;

  const parsedArguments = parseArguments(candidate.arguments);
  if (!isRecord(parsedArguments)) return undefined;
  if (typeof parsedArguments.command === 'string')
    return parsedArguments.command;
  return typeof parsedArguments.cmd === 'string'
    ? parsedArguments.cmd
    : undefined;
}

function parseStatus(
  candidate: JsonObject,
  event: JsonObject,
): ToolEvent['status'] | undefined {
  const status = candidate.status ?? event.status;
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failure' || status === 'failed' || status === 'error') {
    return 'failure';
  }

  const exitCode = candidate.exit_code ?? candidate.exitCode;
  if (typeof exitCode === 'number')
    return exitCode === 0 ? 'success' : 'failure';

  return undefined;
}

function createToolEvent(
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

function shellCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.command === 'string') return input.command;
  return typeof input.cmd === 'string' ? input.cmd : undefined;
}

function parseFailureMessage(
  candidate: JsonObject,
  event: JsonObject,
): string | undefined {
  return stringFromKeys(candidate) ?? stringFromKeys(event);
}

function stringFromKeys(value: JsonObject): string | undefined {
  for (const key of ['message', 'error', 'reason', 'detail', 'stderr']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (isRecord(candidate)) {
      const nested = stringFromKeys(candidate);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function parseFinalMessage(event: JsonObject): string | undefined {
  const item = isRecord(event.item) ? event.item : undefined;

  return (
    textFromMessageLike(item) ??
    textFromMessageLike(event) ??
    textFromContent(event.message) ??
    textFromContent(event.content)
  );
}

function textFromMessageLike(
  value: JsonObject | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const type = value.type;
  if (
    type !== 'agent_message' &&
    type !== 'assistant_message' &&
    type !== 'message' &&
    type !== 'result'
  ) {
    return undefined;
  }

  for (const key of ['text', 'message', 'result', 'content']) {
    const text = textFromContent(value[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textFromContent(content: unknown): string | undefined {
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

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
