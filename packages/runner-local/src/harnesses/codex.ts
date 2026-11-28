import {realpathSync} from 'node:fs';

import type {PermissionMode} from '@dynobox/sdk';

import {prepareMcpHarness} from '../mcpMocks/resolveExecutable.js';
import {
  createToolEvent,
  firstJsonLineString,
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
import {createVersionProbe} from './version.js';

export type CodexHarnessOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

export type CodexParsedOutput = {
  finalMessage: string | undefined;
  toolEvents: ToolEvent[];
  errorMessage: string | undefined;
};

export type CodexParsedLine = {
  toolEvents: ToolEvent[];
  finalMessage?: string;
  /** From `turn.failed` (`fatal`) or a top-level `error` event. */
  errorMessage?: {text: string; fatal: boolean};
};

export class CodexHarness implements Harness {
  readonly id = 'codex' as const;

  readonly executable: string;
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

  /** Resolve the Codex executable before CLI mocks change PATH. */
  async prepareMcp(
    input: Pick<HarnessInput, 'workDir' | 'env'>,
  ): Promise<PreparedMcpHarness> {
    const {runCodexWithMcp} = await import('./codexMcp.js');
    return prepareMcpHarness(
      this.executable,
      this.extraArgs,
      input,
      runCodexWithMcp,
    );
  }

  async run(input: HarnessInput): Promise<HarnessRunOutput> {
    return runStreamingHarness({
      executable: this.executable,
      args: buildCodexArgs(
        input.prompt,
        this.extraArgs,
        input.model,
        input.permissionMode,
        input.cliMocksEnabled ? input.env : undefined,
        input.session?.resumeId,
      ),
      input,
      cwd: realpathSync(input.workDir),
      stdin: 'ignore',
      parseLine: parseCodexJsonLine,
      shouldEmit: createCodexToolEventDeduper(),
    });
  }

  extractResult(raw: HarnessRunOutput): HarnessResult {
    const aliases = raw.metadata?.codexMcpAliases;
    const parsed = parseCodexJson(
      raw.stdout,
      isRecord(aliases)
        ? Object.fromEntries(
            Object.entries(aliases).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          )
        : {},
    );
    const sessionId = codexSessionId(raw.stdout);
    return {
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      transcript: raw.stdout,
      finalMessage: parsed.finalMessage,
      toolEvents: parsed.toolEvents,
      ...(parsed.errorMessage === undefined
        ? {}
        : {errorMessage: parsed.errorMessage}),
      ...(sessionId === undefined ? {} : {sessionId}),
    };
  }
}

/** The thread ID from `thread.started`, which `codex exec resume` accepts. */
export function codexSessionId(stdout: string): string | undefined {
  return firstJsonLineString(stdout, (event) =>
    event.type === 'thread.started' ? event.thread_id : undefined,
  );
}

export function buildCodexArgs(
  prompt: string,
  extraArgs: readonly string[] = [],
  model?: string,
  permissionMode?: PermissionMode,
  cliMockEnv?: Readonly<Record<string, string>>,
  resumeId?: string,
): string[] {
  return [
    'exec',
    ...codexExecOptions(model, permissionMode, cliMockEnv, extraArgs),
    // `exec` options stay before the subcommand; `resume` accepts fewer.
    // `--` keeps a prompt such as "- Use UUIDs" from parsing as an option.
    ...(resumeId === undefined ? ['--'] : ['resume', '--', resumeId]),
    prompt,
  ];
}

/** `codex exec` options without the subcommand or prompt. */
export function codexExecOptions(
  model?: string,
  permissionMode?: PermissionMode,
  cliMockEnv?: Readonly<Record<string, string>>,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    ...codexPermissionArgs(permissionMode),
    ...(model === undefined ? [] : ['--model', model]),
    ...extraArgs,
    ...(cliMockEnv === undefined ? [] : codexCliMockArgs(cliMockEnv)),
  ];
}

export function codexCliMockArgs(
  env: Readonly<Record<string, string>>,
): string[] {
  const args = ['allow_login_shell=false', 'features.shell_snapshot=false'];
  for (const name of CODEX_CLI_MOCK_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) {
      args.push(
        `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
      );
    }
  }
  return args.flatMap((value) => ['-c', value]);
}

const CODEX_CLI_MOCK_ENV_NAMES = [
  'PATH',
  'ZDOTDIR',
  'BASH_ENV',
  'ENV',
  'DYNOBOX_CLI_MOCK_SOCKET',
  'DYNOBOX_CLI_MOCK_NODE',
  'DYNOBOX_CLI_MOCK_CLIENT',
  'DYNOBOX_CLI_MOCK_BIN',
  'DYNOBOX_CLI_MOCK_TIMEOUT_MS',
  'DYNOBOX_CLI_MOCK_SCRIPT_SHELL',
  'DYNOBOX_CLI_MOCK_PATH_HOOK',
  'DYNOBOX_CLI_MOCK_BASE_BASH_ENV',
  'DYNOBOX_CLI_MOCK_BASE_POSIX_ENV',
  'DYNOBOX_CLI_MOCK_BASE_ZDOTDIR',
  'npm_config_script_shell',
  'NPM_CONFIG_SCRIPT_SHELL',
] as const;

function codexPermissionArgs(
  permissionMode: PermissionMode | undefined,
): string[] {
  if (permissionMode !== 'dangerous') return [];
  return ['--sandbox', 'danger-full-access', '-c', 'approval_policy="never"'];
}

export function parseCodexJson(
  stdout: string,
  mcpAliases: Readonly<Record<string, string>> = {},
): CodexParsedOutput {
  let finalMessage: string | undefined;
  let fatalError: string | undefined;
  let lastError: string | undefined;
  const toolEvents: ToolEvent[] = [];

  for (const {line, lineNumber} of jsonLines(stdout)) {
    const parsed = parseCodexJsonLine(line, lineNumber, mcpAliases);
    toolEvents.push(...parsed.toolEvents);

    if (parsed.finalMessage !== undefined) {
      finalMessage = parsed.finalMessage;
    }
    if (parsed.errorMessage !== undefined) {
      lastError = parsed.errorMessage.text;
      if (parsed.errorMessage.fatal) fatalError = parsed.errorMessage.text;
    }
  }

  return {finalMessage, toolEvents, errorMessage: fatalError ?? lastError};
}

export function parseCodexJsonLine(
  line: string,
  lineNumber = 1,
  mcpAliases: Readonly<Record<string, string>> = {},
): CodexParsedLine {
  const event = parseJsonObjectLine(line, lineNumber, 'Codex JSON line');
  const item = isRecord(event.item) ? event.item : undefined;
  if (
    item?.type === 'mcp_tool_call' &&
    typeof item.server === 'string' &&
    Object.hasOwn(mcpAliases, item.server)
  ) {
    const logical = mcpAliases[item.server]!;
    const error = isRecord(item.error) ? item.error : undefined;
    event.item = {
      ...item,
      server: logical,
      ...(typeof error?.message === 'string'
        ? {
            error: {
              ...error,
              message: error.message.split(item.server).join(logical),
            },
          }
        : {}),
    };
  }
  const toolEvents = parseToolEvents(event);
  const finalMessage = parseFinalMessage(event);
  const errorMessage = parseTurnError(event);

  return {
    toolEvents,
    ...(finalMessage === undefined ? {} : {finalMessage}),
    ...(errorMessage === undefined ? {} : {errorMessage}),
  };
}

/**
 * Codex reports a failed turn as `turn.failed` (and usually a top-level
 * `error` event first). The message is often a JSON API error; keep only its
 * inner message. `item.completed` items of type `error` are warnings, such as
 * missing model metadata, and are not used.
 */
function parseTurnError(
  event: JsonObject,
): CodexParsedLine['errorMessage'] | undefined {
  const raw =
    event.type === 'turn.failed' && isRecord(event.error)
      ? event.error.message
      : event.type === 'error'
        ? event.message
        : undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  return {
    text: apiErrorMessage(raw.trim()),
    fatal: event.type === 'turn.failed',
  };
}

function apiErrorMessage(message: string): string {
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed)) {
      const inner = isRecord(parsed.error) ? parsed.error.message : undefined;
      if (typeof inner === 'string' && inner.trim().length > 0) {
        return inner.trim();
      }
    }
  } catch {
    // Not JSON; use the message as is.
  }
  return message;
}

export function createCodexToolEventDeduper(): (
  event: ToolEvent,
  line: string,
) => boolean {
  // One item can carry several events (a multi-file `file_change`), so key on
  // the event input as well as the item id.
  const seen = new Set<string>();

  return (event, line) => {
    const itemId = extractItemId(line);
    if (itemId === undefined) return true;
    const key = `${itemId}\0${JSON.stringify(event.input)}`;
    if (seen.has(key)) return false;
    seen.add(key);
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
  if (item?.type === 'file_change') return parseFileChangeEvents(item, event);
  const toolEvent = parseToolEvent(item ?? event, event);
  return toolEvent === undefined ? [] : [toolEvent];
}

// Codex reports patch edits as one `file_change` item listing every path, so
// emit one file event per path: `add` writes a file, anything else edits one.
function parseFileChangeEvents(
  item: JsonObject,
  event: JsonObject,
): ToolEvent[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const status = parseStatus(item, event);
  return changes.flatMap((change) => {
    if (!isRecord(change) || typeof change.path !== 'string') return [];
    return [
      createToolEvent(
        'file_change',
        {path: change.path, kind: change.kind},
        status,
        undefined,
        change.kind === 'add' ? 'write_file' : 'edit_file',
      ),
    ];
  });
}

function parseToolEvent(
  candidate: JsonObject,
  event: JsonObject,
): ToolEvent | undefined {
  if (candidate.type === 'mcp_tool_call') {
    const result = isRecord(candidate.result) ? candidate.result : undefined;
    const toolFailed = result?.isError === true;
    return createToolEvent(
      `mcp__${String(candidate.server)}__${String(candidate.tool)}`,
      parseToolInput(candidate),
      toolFailed ? 'failure' : parseStatus(candidate, event),
      parseFailureMessage(candidate, event) ??
        (toolFailed ? textFromContent(result.content) : undefined),
    );
  }

  if (candidate.type === 'web_search' && isOpenPageAction(candidate.action)) {
    const errorMessage = openPageErrorOnlyMessage(candidate);
    const parsedStatus = parseStatus(candidate, event);
    const status =
      parsedStatus === 'failure' || errorMessage !== undefined
        ? 'failure'
        : (parsedStatus ?? 'success');
    const url =
      typeof candidate.action.url === 'string'
        ? candidate.action.url
        : undefined;
    return createToolEvent(
      'web_search',
      {...candidate, ...(url === undefined ? {} : {url})},
      status,
      parseFailureMessage(candidate, event) ?? errorMessage,
      'web_fetch',
    );
  }

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

function isOpenPageAction(value: unknown): value is JsonObject {
  return isRecord(value) && value.type === 'open_page';
}

function openPageErrorOnlyMessage(candidate: JsonObject): string | undefined {
  if (!Array.isArray(candidate.results) || candidate.results.length === 0) {
    return undefined;
  }
  const errorMessages: string[] = [];
  for (const result of candidate.results) {
    const message = errorResultMessage(result);
    if (message === undefined) return undefined;
    errorMessages.push(message);
  }
  return errorMessages[0];
}

function errorResultMessage(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.error === 'string' && result.error.trim().length > 0) {
    return result.error.trim();
  }
  if (
    result.type === 'error' ||
    result.isError === true ||
    result.is_error === true
  ) {
    if (
      typeof result.message === 'string' &&
      result.message.trim().length > 0
    ) {
      return result.message.trim();
    }
    if (typeof result.title === 'string' && result.title.trim().length > 0) {
      return result.title.trim();
    }
    return 'Error';
  }
  const hasContent =
    (typeof result.snippet === 'string' && result.snippet.trim().length > 0) ||
    (typeof result.text === 'string' && result.text.trim().length > 0) ||
    (typeof result.content === 'string' && result.content.trim().length > 0);
  if (
    !hasContent &&
    typeof result.title === 'string' &&
    /\berror\b|not found|forbidden|unauthorized|unavailable|timeout/i.test(
      result.title,
    )
  ) {
    return result.title.trim();
  }
  return undefined;
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
