import type {PermissionMode} from '@dynobox/sdk';

import {prepareMcpHarness} from '../mcpMocks/resolveExecutable.js';
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
  PreparedMcpHarness,
  ToolEvent,
} from './types.js';
import {createVersionProbe, isAtLeastVersion} from './version.js';

export type PiHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

// Oldest release verified for stdin prompts, `--no-extensions` isolation and
// `systemPromptOptions` edits from extensions.
export const PI_MIN_VERSION = '0.86.0';

export type PiParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
  errorMessage: string | undefined;
  terminalFailure: boolean;
};

export type PiParsedLine = {
  toolEvents: ToolEvent[];
  finalMessage?: string;
  errorMessage?: string;
  terminalFailure?: boolean;
};

export class PiHarness implements Harness {
  readonly id = 'pi' as const;

  readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly probeVersion: () => Promise<string | null>;

  constructor(options: PiHarnessOptions = {}) {
    this.executable = options.executable ?? 'pi';
    this.extraArgs = options.extraArgs ?? [];
    this.probeVersion = createVersionProbe(this.executable);
  }

  version(): Promise<string | null> {
    return this.probeVersion();
  }

  async prepareMcp(
    input: Pick<HarnessInput, 'workDir' | 'env'>,
  ): Promise<PreparedMcpHarness> {
    const {runPiWithMcp} = await import('./piMcp.js');
    return prepareMcpHarness(
      this.executable,
      this.extraArgs,
      input,
      runPiWithMcp,
    );
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    const toolInputs = new Map<string, unknown>();
    const version = await this.version();
    if (version === null || !isAtLeastVersion(version, PI_MIN_VERSION))
      throw new Error(
        `Pi ${PI_MIN_VERSION} or newer is required (found ${version ?? 'unknown'}).`,
      );
    return runStreamingHarness({
      executable: this.executable,
      args: buildPiArgs(this.extraArgs, input.model, input.permissionMode),
      input: {
        ...input,
        env: {...input.env, PI_OFFLINE: '1'},
      },
      processInput: input.prompt,
      parseLine: (line, lineNumber) =>
        parsePiJsonLine(line, lineNumber, toolInputs),
    });
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const parsed = parsePiJson(raw.stdout);
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

export function buildPiArgs(
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
): string[] {
  return [
    '--mode',
    'json',
    '--no-session',
    ...piPermissionArgs(permissionMode),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
  ];
}

function piPermissionArgs(
  permissionMode: PermissionMode | undefined,
): string[] {
  return [permissionMode === 'dangerous' ? '--approve' : '--no-approve'];
}

export function parsePiJson(stdout: string): PiParsedOutput {
  let finalMessage: string | undefined;
  let errorMessage: string | undefined;
  let terminalFailure = false;
  const toolEvents: ToolEvent[] = [];
  const toolInputs = new Map<string, unknown>();

  let responded = false;
  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parsePiJsonLine(line, lineNumber, toolInputs);
    toolEvents.push(...parsed.toolEvents);
    if (parsed.terminalFailure !== undefined) {
      responded = true;
      finalMessage = parsed.finalMessage;
      terminalFailure = parsed.terminalFailure;
      errorMessage = parsed.errorMessage;
    }
  }
  // Pi trims stdin and exits 0 without calling the model when nothing is left.
  if (!responded) {
    terminalFailure = true;
    errorMessage = 'Pi finished without a model response.';
  }

  return {finalMessage, toolEvents, errorMessage, terminalFailure};
}

export function parsePiJsonLine(
  line: string,
  lineNumber = 1,
  toolInputs = new Map<string, unknown>(),
): PiParsedLine {
  const event = parseJsonObjectLine(line, lineNumber, 'Pi JSON event');
  if (event.type === 'tool_execution_start') {
    rememberToolInput(event, toolInputs);
    return {toolEvents: []};
  }

  if (event.type === 'tool_execution_end') {
    return {toolEvents: parseToolEnd(event, toolInputs)};
  }

  if (event.type !== 'message_end' || !isRecord(event.message)) {
    return {toolEvents: []};
  }

  return parseAssistantMessage(event.message);
}

function rememberToolInput(
  event: JsonObject,
  toolInputs: Map<string, unknown>,
): void {
  if (typeof event.toolCallId !== 'string' || !('args' in event)) return;
  toolInputs.set(event.toolCallId, event.args);
}

function parseToolEnd(
  event: JsonObject,
  toolInputs: Map<string, unknown>,
): ToolEvent[] {
  if (
    typeof event.toolCallId !== 'string' ||
    typeof event.toolName !== 'string'
  ) {
    return [];
  }

  const input = toolInputs.get(event.toolCallId) ?? {};
  toolInputs.delete(event.toolCallId);
  const status = event.isError === true ? 'failure' : 'success';
  const message = textFromPiContent(event.result);
  return [createToolEvent(event.toolName, input, status, message)];
}

function textFromPiContent(content: unknown): string | undefined {
  const text = textFromContent(content);
  if (text !== undefined) return text;
  if (!isRecord(content)) return undefined;
  const nestedText = textFromContent(content.content);
  if (nestedText !== undefined) return nestedText;
  return typeof content.text === 'string' ? content.text : undefined;
}

function parseAssistantMessage(message: JsonObject): PiParsedLine {
  if (message.role !== 'assistant') return {toolEvents: []};

  const finalMessage = textFromContent(message.content);
  const terminalFailure =
    message.stopReason === 'error' || message.stopReason === 'aborted';
  const providedError =
    typeof message.errorMessage === 'string' &&
    message.errorMessage.trim() !== ''
      ? message.errorMessage
      : undefined;
  const errorMessage = terminalFailure
    ? (providedError ??
      (message.stopReason === 'aborted'
        ? 'Pi stream aborted'
        : 'Pi stream ended with an error'))
    : undefined;
  return {
    toolEvents: [],
    ...(finalMessage === undefined ? {} : {finalMessage}),
    ...(errorMessage === undefined ? {} : {errorMessage}),
    terminalFailure,
  };
}
