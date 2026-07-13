import type {PermissionMode} from '@dynobox/sdk';
import {realpathSync} from 'fs';

import {
  createToolEvent,
  isRecord,
  jsonLines,
  type JsonObject,
  parseJsonObjectLine,
  textFromContent,
} from './parsing.js';
import {runStreamingHarness} from './runStreamingHarness.js';
import {createVersionProbe} from './version.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  ToolEvent,
} from './types.js';

export type CodexHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

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
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: CodexHarnessOptions = {}) {
    this.executable = options.executable ?? 'codex';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    return runStreamingHarness({
      executable: this.executable,
      args: buildCodexArgs(
        input.prompt,
        this.extraArgs,
        input.model,
        input.permissionMode,
      ),
      input,
      cwd: realpathSync(input.workDir),
      stdin: 'ignore',
      parseLine: parseCodexJsonLine,
      shouldEmit: createCodexToolEventDeduper(),
    });
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
  const event = parseJsonObjectLine(line, lineNumber, 'Codex JSON line');
  const toolEvents = parseToolEvents(event);
  const finalMessage = parseFinalMessage(event);

  return {
    toolEvents,
    ...(finalMessage === undefined ? {} : {finalMessage}),
  };
}

function createCodexToolEventDeduper(): (
  event: ToolEvent,
  line: string,
) => boolean {
  const seenItemIds = new Set<string>();

  return (_event, line) => {
    const itemId = extractItemId(line);
    if (itemId === undefined) return true;
    if (seenItemIds.has(itemId)) return false;
    seenItemIds.add(itemId);
    return true;
  };
}

function extractItemId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line);
    if (isRecord(parsed) && isRecord(parsed.item)) {
      return typeof parsed.item.id === 'string' ? parsed.item.id : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
