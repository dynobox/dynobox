import {realpathSync} from 'node:fs';

import type {PermissionMode} from '@dynobox/sdk';
import {execa} from 'execa';

import {prepareMcpHarness} from '../mcpMocks/resolveExecutable.js';
import {
  createToolEvent,
  isRecord,
  jsonLines,
  type JsonObject,
  parseJsonObjectLine,
} from './parsing.js';
import {runStreamingHarness} from './runStreamingHarness.js';
import type {
  Harness,
  HarnessInput,
  HarnessResult,
  HarnessRunOutput,
  PreparedMcpHarness,
  ToolEvent,
} from './types.js';
import {createVersionProbe} from './version.js';

export type OpenCodeHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

export type OpenCodeParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
  errorMessage: string | undefined;
};

export type OpenCodeParsedLine = {
  toolEvents: ToolEvent[];
  messageId?: string;
  sessionId?: string;
  toolPartId?: string;
  textPart?: {
    id?: string;
    messageId?: string;
    text: string;
  };
  errorMessage?: string;
};

const MCP_PREFIXES_METADATA_KEY = 'opencodeMcpPrefixes';

export class OpenCodeHarness implements Harness {
  readonly id = 'opencode' as const;

  readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: OpenCodeHarnessOptions = {}) {
    this.executable = options.executable ?? 'opencode';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async prepareMcp(
    input: Pick<HarnessInput, 'workDir' | 'env'>,
  ): Promise<PreparedMcpHarness> {
    const {runOpenCodeWithMcp} = await import('./opencodeMcp.js');
    return prepareMcpHarness(
      this.executable,
      this.extraArgs,
      input,
      runOpenCodeWithMcp,
    );
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const startedAt = Date.now();
    const workDir = realpathSync(input.workDir);
    const mcpPrefixes = await resolveOpenCodeMcpPrefixes(
      this.executable,
      workDir,
      input.env,
      input.timeoutMs,
    );
    const preflightMs = Date.now() - startedAt;
    if (input.timeoutMs !== undefined && preflightMs >= input.timeoutMs) {
      throw new Error(
        `OpenCode invocation timed out after ${input.timeoutMs} milliseconds`,
      );
    }
    const runInput =
      input.timeoutMs === undefined
        ? input
        : {...input, timeoutMs: input.timeoutMs - preflightMs};
    const output = await runStreamingHarness({
      executable: this.executable,
      args: buildOpenCodeArgs(
        this.extraArgs,
        input.model,
        input.permissionMode,
      ),
      input: runInput,
      cwd: workDir,
      processInput: input.prompt,
      parseLine: (line, lineNumber) =>
        parseOpenCodeJsonLine(line, lineNumber, mcpPrefixes),
      shouldEmit: createOpenCodeToolEventDeduper(),
    });
    return {
      ...output,
      durationMs: Date.now() - startedAt,
      metadata: {[MCP_PREFIXES_METADATA_KEY]: mcpPrefixes},
    };
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const primary = raw.metadata?.opencodeSessionId;
    const parsed = parseOpenCodeJson(
      raw.stdout,
      mcpPrefixesFromOutput(raw),
      typeof primary === 'string' ? primary : undefined,
    );
    return {
      exitCode: raw.exitCode,
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

/**
 * OpenCode v2 removed `run --dir`; the process cwd (the job workDir) selects
 * the project. `--standalone` gives each job a private server, so jobs do not
 * share the user's background service, its config, or its session list.
 */
export function buildOpenCodeArgs(
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
): string[] {
  return [
    'run',
    '--standalone',
    '--format',
    'json',
    ...(permissionMode === 'dangerous' ? ['--auto'] : []),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
  ];
}

export function parseOpenCodeJson(
  stdout: string,
  mcpPrefixes: readonly string[] = [],
  primarySessionId?: string,
): OpenCodeParsedOutput {
  const toolEvents: ToolEvent[] = [];
  const seenToolPartIds = new Set<string>();
  const seenTextPartIds = new Set<string>();
  const messages = new Map<string, string[]>();
  const errors: string[] = [];
  let lastMessageId: string | undefined;

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseOpenCodeJsonLine(line, lineNumber, mcpPrefixes);
    const primary =
      primarySessionId === undefined || parsed.sessionId === primarySessionId;
    if (primary && parsed.messageId !== undefined)
      lastMessageId = parsed.messageId;
    if (
      parsed.toolPartId === undefined ||
      !seenToolPartIds.has(parsed.toolPartId)
    ) {
      toolEvents.push(...parsed.toolEvents);
      if (parsed.toolPartId !== undefined) {
        seenToolPartIds.add(parsed.toolPartId);
      }
    }

    const textPart = parsed.textPart;
    if (
      textPart !== undefined &&
      primary &&
      textPart.text.trim().length > 0 &&
      (textPart.id === undefined || !seenTextPartIds.has(textPart.id))
    ) {
      if (textPart.id !== undefined) seenTextPartIds.add(textPart.id);
      const messageId = textPart.messageId ?? `line:${lineNumber}`;
      const parts = messages.get(messageId) ?? [];
      parts.push(textPart.text);
      messages.set(messageId, parts);
      lastMessageId = messageId;
    }

    if (parsed.errorMessage !== undefined) errors.push(parsed.errorMessage);
  }

  return {
    finalMessage:
      lastMessageId === undefined
        ? undefined
        : messages.get(lastMessageId)?.join(''),
    toolEvents,
    errorMessage: errors.length === 0 ? undefined : errors.join('\n'),
  };
}

export function parseOpenCodeJsonLine(
  line: string,
  lineNumber = 1,
  mcpPrefixes: readonly string[] = [],
): OpenCodeParsedLine {
  const event = parseJsonObjectLine(line, lineNumber, 'OpenCode JSON line');
  const toolEvent = parseToolEvent(event, mcpPrefixes);
  const part = isRecord(event.part) ? event.part : undefined;
  const toolPartId =
    toolEvent === undefined || !part ? undefined : toolPartIdentity(part);
  const textPart = parseTextPart(event);
  const errorMessage = parseErrorMessage(event);

  return {
    toolEvents: toolEvent === undefined ? [] : [toolEvent],
    ...(typeof part?.messageID === 'string' ? {messageId: part.messageID} : {}),
    ...(typeof event.sessionID === 'string'
      ? {sessionId: event.sessionID}
      : {}),
    ...(toolPartId === undefined ? {} : {toolPartId}),
    ...(textPart === undefined ? {} : {textPart}),
    ...(errorMessage === undefined ? {} : {errorMessage}),
  };
}

function parseToolEvent(
  event: JsonObject,
  mcpPrefixes: readonly string[],
): ToolEvent | undefined {
  if (event.type !== 'tool_use') return undefined;
  const part = isRecord(event.part) ? event.part : undefined;
  if (part?.type !== 'tool' || typeof part.tool !== 'string') return undefined;
  const rawName = part.tool;
  const state = isRecord(part.state) ? part.state : undefined;
  if (state === undefined) return undefined;

  const status = parseToolStatus(state);
  const kindOverride = mcpPrefixes.some((prefix) => rawName.startsWith(prefix))
    ? 'mcp'
    : undefined;
  return createToolEvent(
    rawName,
    state.input,
    status,
    status === 'failure' ? parseFailureMessage(state) : undefined,
    kindOverride,
  );
}

function parseToolStatus(state: JsonObject): ToolEvent['status'] | undefined {
  const outer = isRecord(state.metadata) ? state.metadata : undefined;
  const metadata =
    outer !== undefined && 'exit' in outer
      ? outer
      : isRecord(outer?.metadata)
        ? outer.metadata
        : undefined;
  const exitCode = metadata?.exit;
  if (typeof exitCode === 'number') {
    return exitCode === 0 ? 'success' : 'failure';
  }
  if (metadata !== undefined && 'exit' in metadata && exitCode === null) {
    return 'failure';
  }
  if (state.status === 'completed') return 'success';
  if (state.status === 'error') return 'failure';
  return undefined;
}

function parseFailureMessage(state: JsonObject): string | undefined {
  const error = state.error;
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message.trim();
  }
  if (typeof state.output === 'string' && state.output.trim().length > 0) {
    return state.output.trim();
  }
  return undefined;
}

function parseTextPart(
  event: JsonObject,
): OpenCodeParsedLine['textPart'] | undefined {
  if (event.type !== 'text') return undefined;
  const part = isRecord(event.part) ? event.part : undefined;
  if (part?.type !== 'text') return undefined;
  if (typeof part.text !== 'string') return undefined;
  return {
    text: part.text,
    ...(typeof part.id === 'string' ? {id: part.id} : {}),
    ...(typeof part.messageID === 'string' ? {messageId: part.messageID} : {}),
  };
}

function parseErrorMessage(event: JsonObject): string | undefined {
  if (event.type !== 'error') return undefined;
  return messageFromUnknown(event.error);
}

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const message = value.trim();
    return message.length === 0 ? undefined : message;
  }
  if (!isRecord(value)) return undefined;

  for (const key of ['message', 'detail', 'data', 'error']) {
    const message = messageFromUnknown(value[key]);
    if (message !== undefined) return message;
  }
  return typeof value.name === 'string' ? value.name : undefined;
}

function createOpenCodeToolEventDeduper(): (
  event: ToolEvent,
  line: string,
) => boolean {
  const seenPartIds = new Set<string>();

  return (_event, line) => {
    const partId = extractPartId(line);
    if (partId === undefined) return true;
    if (seenPartIds.has(partId)) return false;
    seenPartIds.add(partId);
    return true;
  };
}

function extractPartId(line: string): string | undefined {
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || !isRecord(event.part)) return undefined;
    return toolPartIdentity(event.part);
  } catch {
    return undefined;
  }
}

function toolPartIdentity(part: JsonObject): string | undefined {
  if (typeof part.partID === 'string') return part.partID;
  if (typeof part.id !== 'string') return undefined;
  return typeof part.messageID === 'string'
    ? `${part.messageID}:${part.id}`
    : part.id;
}

async function resolveOpenCodeMcpPrefixes(
  executable: string,
  workDir: string,
  env: Record<string, string>,
  timeoutMs?: number,
): Promise<string[]> {
  try {
    const result = await execa(executable, ['debug', 'config'], {
      cwd: workDir,
      env: {...process.env, ...env, PWD: workDir},
      reject: false,
      stdin: 'ignore',
      timeout: Math.min(timeoutMs ?? 10_000, 10_000),
    });
    if (result.exitCode !== 0) return [];
    return mcpPrefixesFromConfig(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

/**
 * OpenCode v1 prints one merged config object with the servers directly
 * under `mcp`. OpenCode v2 prints a list of config sources
 * (`[{type, path, info}]`) in precedence order, with the servers under
 * `mcp.servers`, so later sources override earlier ones for the same
 * server. OpenCode v2 also converts v1 config files to this shape and
 * prints `enabled: true` as `disabled: false`.
 */
export function mcpPrefixesFromConfig(config: unknown): string[] {
  const sources = Array.isArray(config)
    ? config.map((source) => (isRecord(source) ? source.info : undefined))
    : [config];
  const servers: Record<string, unknown> = {};
  for (const source of sources) {
    if (isRecord(source) && isRecord(source.mcp)) {
      Object.assign(
        servers,
        isRecord(source.mcp.servers) ? source.mcp.servers : source.mcp,
      );
    }
  }
  return Object.entries(servers)
    .filter(
      ([, value]) =>
        !isRecord(value) ||
        (value.enabled !== false && value.disabled !== true),
    )
    .map(([name]) => `${sanitizeOpenCodeToolName(name)}_`);
}

function sanitizeOpenCodeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function mcpPrefixesFromOutput(raw: HarnessRunOutput): string[] {
  const value = raw.metadata?.[MCP_PREFIXES_METADATA_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
