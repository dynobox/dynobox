import {execa} from 'execa';

import {normalizeToolKind} from './tool-events.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ShellToolEvent,
  ToolEvent,
} from './types.js';

export type ClaudeCodeHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

type JsonObject = Record<string, unknown>;

export type ClaudeCodeParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
};

export type ClaudeCodeParsedLine = {
  toolEvents: ToolEvent[];
  resultMessage?: string;
  assistantMessage?: string;
};

export class ClaudeCodeHarness implements Harness {
  readonly id = 'claude-code' as const;

  private readonly executable: string;
  private readonly extraArgs: readonly string[];

  constructor(options: ClaudeCodeHarnessOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.extraArgs = options.extraArgs ?? [];
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const options = {
      cwd: input.workDir,
      env: {...process.env, ...input.env},
      reject: false,
      ...(input.timeoutMs === undefined ? {} : {timeout: input.timeoutMs}),
    };

    const subprocess = execa(
      this.executable,
      buildClaudeCodeArgs(input.prompt, this.extraArgs),
      options,
    );
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const streamParser = new ClaudeCodeToolEventStream((toolEvent) => {
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
    const parsed = parseClaudeCodeStreamJson(raw.stdout);
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: parsed.finalMessage,
      toolEvents: parsed.toolEvents,
    };
  }
}

export function buildClaudeCodeArgs(
  prompt: string,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-hook-events',
    ...extraArgs,
    prompt,
  ];
}

export function parseClaudeCodeStreamJson(
  stdout: string,
): ClaudeCodeParsedOutput {
  let resultMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  const toolEvents: ToolEvent[] = [];

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseClaudeCodeStreamJsonLine(line, lineNumber);
    toolEvents.push(...parsed.toolEvents);

    if (parsed.resultMessage !== undefined) {
      resultMessage = parsed.resultMessage;
    }

    if (parsed.assistantMessage !== undefined) {
      lastAssistantMessage = parsed.assistantMessage;
    }
  }

  return {
    finalMessage: resultMessage ?? lastAssistantMessage,
    toolEvents,
  };
}

export function parseClaudeCodeStreamJsonLine(
  line: string,
  lineNumber = 1,
): ClaudeCodeParsedLine {
  const event = parseJsonObjectLine(line, lineNumber);
  const toolEvents = parseToolEvents(event);
  const resultMessage = parseResultMessage(event);
  const assistantMessage = parseAssistantMessage(event);

  return {
    toolEvents,
    ...(resultMessage === undefined ? {} : {resultMessage}),
    ...(assistantMessage === undefined ? {} : {assistantMessage}),
  };
}

class ClaudeCodeToolEventStream {
  private buffer = '';
  private lineNumber = 0;

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
      const parsed = parseClaudeCodeStreamJsonLine(line, this.lineNumber);
      for (const toolEvent of parsed.toolEvents) {
        this.onToolEvent(toolEvent);
      }
    } catch {
      // Final extraction reports malformed stdout with a precise line number.
    }
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
      `Failed to parse Claude Code stream JSON line ${lineNumber}: ${message}`,
      {cause: error},
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Failed to parse Claude Code stream JSON line ${lineNumber}: expected an object.`,
    );
  }
  return parsed;
}

function parseToolEvents(event: JsonObject): ToolEvent[] {
  const toolEvent = parseToolEvent(event);
  const assistantEvents = parseAssistantToolEvents(event);
  return toolEvent === undefined
    ? assistantEvents
    : [toolEvent, ...assistantEvents];
}

function parseToolEvent(event: JsonObject): ToolEvent | undefined {
  if (
    typeof event.hook_event_name !== 'string' ||
    typeof event.tool_name !== 'string' ||
    !('tool_input' in event)
  ) {
    return undefined;
  }

  const rawName = event.tool_name;
  return createToolEvent(
    rawName,
    event.tool_input,
    hookStatus(event.hook_event_name),
  );
}

function parseAssistantToolEvents(event: JsonObject): ToolEvent[] {
  if (event.type !== 'assistant') return [];

  const content = assistantContent(event);
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== 'tool_use' ||
      typeof part.name !== 'string' ||
      !('input' in part)
    ) {
      return [];
    }

    return [createToolEvent(part.name, part.input)];
  });
}

function createToolEvent(
  rawName: string,
  input: unknown,
  status: ToolEvent['status'] | undefined = undefined,
): ToolEvent {
  const kind = normalizeToolKind(rawName);
  const base: ToolEvent =
    status === undefined
      ? {kind, rawName, input}
      : {kind, rawName, input, status};

  const command = shellCommand(input);
  if (kind === 'shell' && command !== undefined) {
    const shellEvent: ShellToolEvent = {...base, kind: 'shell', command};
    return shellEvent;
  }

  return base;
}

function hookStatus(hookEventName: string): ToolEvent['status'] | undefined {
  if (hookEventName === 'PostToolUse') return 'success';
  if (hookEventName === 'PostToolUseFailure') return 'failure';
  return undefined;
}

function shellCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return typeof input.command === 'string' ? input.command : undefined;
}

function parseResultMessage(event: JsonObject): string | undefined {
  if (event.type !== 'result') return undefined;
  return typeof event.result === 'string' ? event.result : undefined;
}

function parseAssistantMessage(event: JsonObject): string | undefined {
  if (event.type !== 'assistant') return undefined;

  const messageText = textFromMessage(event.message);
  if (messageText !== undefined) return messageText;

  return textFromContent(event.content);
}

function assistantContent(event: JsonObject): unknown {
  if (isRecord(event.message)) return event.message.content;
  return event.content;
}

function textFromMessage(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  return textFromContent(message.content);
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
