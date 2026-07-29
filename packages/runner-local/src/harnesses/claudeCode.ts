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

export type ClaudeCodeHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

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

  readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: ClaudeCodeHarnessOptions = {}) {
    this.executable = options.executable ?? 'claude';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    return runStreamingHarness({
      executable: this.executable,
      args: buildClaudeCodeArgs(
        input.prompt,
        this.extraArgs,
        input.model,
        input.permissionMode,
      ),
      input,
      parseLine: parseClaudeCodeStreamJsonLine,
    });
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
  model?: string,
  permissionMode?: PermissionMode,
): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-hook-events',
    ...(model === undefined ? [] : ['--model', model]),
    ...claudeCodePermissionArgs(permissionMode),
    ...extraArgs,
    prompt,
  ];
}

function claudeCodePermissionArgs(
  permissionMode: PermissionMode | undefined,
): string[] {
  if (permissionMode !== 'dangerous') return [];
  return ['--permission-mode', 'bypassPermissions'];
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
  const event = parseJsonObjectLine(
    line,
    lineNumber,
    'Claude Code stream JSON line',
  );
  const toolEvents = parseToolEvents(event);
  const resultMessage = parseResultMessage(event);
  const assistantMessage = parseAssistantMessage(event);

  return {
    toolEvents,
    ...(resultMessage === undefined ? {} : {resultMessage}),
    ...(assistantMessage === undefined ? {} : {assistantMessage}),
  };
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
    failureMessage(event),
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

function hookStatus(hookEventName: string): ToolEvent['status'] | undefined {
  if (hookEventName === 'PostToolUse') return 'success';
  if (hookEventName === 'PostToolUseFailure') return 'failure';
  return undefined;
}

function failureMessage(event: JsonObject): string | undefined {
  for (const key of ['message', 'error', 'reason', 'detail']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
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
