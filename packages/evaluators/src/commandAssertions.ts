import type {IrAssertion} from '@dynobox/sdk/ir';
import {parse as parseShellCommand, type ParseEntry} from 'shell-quote';

import {describeCommandMatcher} from './presentation.js';
import {passed} from './results.js';
import type {AssertionResult, CliMockCall, ToolEvent} from './types.js';

export type ObservedCommand = {
  toolCallId: string;
  executable: string;
  executablePath?: string;
  argv: string[];
  cwd?: string;
  cwdFlag?: string;
  shell?: string;
  original: string;
  eventIndex: number;
  segmentIndex: number;
  start: number;
  end: number;
  cliMockCallIndex?: number;
  cliMockEventPaired?: boolean;
};

export type CommandObservationOptions = {
  cliMockCalls?: readonly CliMockCall[];
  cliMockExecutableNames?: readonly string[];
};

type CommandCalledAssertion = Extract<IrAssertion, {type: 'command.called'}>;
type CommandNotCalledAssertion = Extract<
  IrAssertion,
  {type: 'command.notCalled'}
>;
export type CommandCalledStep = Omit<CommandCalledAssertion, 'id'>;
type CommandNotCalledStep = Omit<CommandNotCalledAssertion, 'id'>;
type CommandMatcher = NonNullable<CommandCalledAssertion['command']>;

export function evaluateCommandCalledAssertion(
  assertion: CommandCalledAssertion,
  toolEvents: readonly ToolEvent[],
  options?: CommandObservationOptions,
): AssertionResult {
  const observed = extractObservedCommands(toolEvents, options);
  const match = observed.find((command) =>
    commandMatchesAssertion(command, assertion),
  );

  if (match !== undefined) {
    return passed(
      assertion,
      `Observed command ${describeExpectedCommand(assertion)}.`,
      match,
    );
  }

  const sameExecutable = observed.some(
    (command) => command.executable === assertion.executable,
  );
  const rawShellMatches = sameExecutable
    ? []
    : rawShellCommandsMatching(toolEvents, assertion.executable);

  return {
    assertionId: assertion.id,
    type: assertion.type,
    passed: false,
    message: commandCalledFailMessage(assertion, observed, rawShellMatches),
    // Keep evidence as ObservedCommand[] so CLI/upload consumers that check
    // Array.isArray(evidence) still render the observed command list. Raw shell
    // matches for normalization gaps live in the failure message only.
    evidence: observed,
  };
}

export function evaluateCommandNotCalledAssertion(
  assertion: CommandNotCalledAssertion,
  toolEvents: readonly ToolEvent[],
  options?: CommandObservationOptions,
): AssertionResult {
  const observed = extractObservedCommands(toolEvents, options);
  const match = observed.find((command) =>
    commandMatchesAssertion(command, assertion),
  );

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      type: assertion.type,
      passed: false,
      message: `Expected no command ${describeExpectedCommand(assertion)}, but observed a matching command.`,
      evidence: match,
    };
  }

  return passed(
    assertion,
    `Observed no command ${describeExpectedCommand(assertion)}.`,
  );
}

export function extractObservedCommands(
  toolEvents: readonly ToolEvent[],
  options?: CommandObservationOptions,
): ObservedCommand[] {
  const shellCommands: ObservedCommand[] = [];
  toolEvents.forEach((event, eventIndex) => {
    if (event.kind !== 'shell' || typeof event.command !== 'string') return;
    shellCommands.push(
      ...parseCommand(event.command, event, eventIndex, shellCommands.length),
    );
  });

  const cliMockCalls = options?.cliMockCalls ?? [];
  const mockExecutableNames = new Set([
    ...(options?.cliMockExecutableNames ?? []),
    ...cliMockCalls.map((call) => call.executable),
  ]);
  if (mockExecutableNames.size === 0) return shellCommands;

  const pairedShellIndexes = new Set<number>();
  const shellPairByCallIndex = new Map<number, number>();
  const shellCommandCounts = new Map<number, number>();
  let lastPairedShellIndex = -1;
  for (const command of shellCommands) {
    shellCommandCounts.set(
      command.eventIndex,
      (shellCommandCounts.get(command.eventIndex) ?? 0) + 1,
    );
  }
  const eligibleShellSignatureCounts = new Map<string, number>();
  for (const command of shellCommands) {
    if (
      shellCommandCounts.get(command.eventIndex) !== 1 ||
      command.executablePath !== undefined
    ) {
      continue;
    }
    const signature = commandSignature(command.executable, command.argv);
    eligibleShellSignatureCounts.set(
      signature,
      (eligibleShellSignatureCounts.get(signature) ?? 0) + 1,
    );
  }
  const callSignatureCounts = new Map<string, number>();
  for (const call of cliMockCalls) {
    const signature = commandSignature(call.executable, call.argv);
    callSignatureCounts.set(
      signature,
      (callSignatureCounts.get(signature) ?? 0) + 1,
    );
  }
  cliMockCalls.forEach((call, callIndex) => {
    const signature = commandSignature(call.executable, call.argv);
    if (
      eligibleShellSignatureCounts.get(signature) !==
      callSignatureCounts.get(signature)
    ) {
      return;
    }
    const shellIndex = shellCommands.findIndex(
      (command, index) =>
        index > lastPairedShellIndex &&
        !pairedShellIndexes.has(index) &&
        shellCommandCounts.get(command.eventIndex) === 1 &&
        command.executablePath === undefined &&
        command.executable === call.executable &&
        arraysEqual(command.argv, call.argv),
    );
    if (shellIndex === -1) return;
    pairedShellIndexes.add(shellIndex);
    shellPairByCallIndex.set(callIndex, shellIndex);
    lastPairedShellIndex = shellIndex;
  });

  const callPairByShellIndex = new Map(
    [...shellPairByCallIndex].map(([callIndex, shellIndex]) => [
      shellIndex,
      callIndex,
    ]),
  );
  const observed: ObservedCommand[] = [];
  shellCommands.forEach((command, shellIndex) => {
    const callIndex = callPairByShellIndex.get(shellIndex);
    if (callIndex !== undefined) {
      const call = cliMockCalls[callIndex]!;
      observed.push({
        ...command,
        executable: call.executable,
        argv: [...call.argv],
        cwd: call.cwd,
        cliMockCallIndex: callIndex,
        cliMockEventPaired: true,
      });
      return;
    }

    if (
      command.executablePath === undefined &&
      mockExecutableNames.has(command.executable) &&
      callSignatureCounts.has(
        commandSignature(command.executable, command.argv),
      )
    ) {
      return;
    }
    observed.push(command);
  });

  cliMockCalls.forEach((call, callIndex) => {
    if (shellPairByCallIndex.has(callIndex)) return;
    const original = [call.executable, ...call.argv].join(' ');
    observed.push({
      toolCallId: `cli-mock:${callIndex}`,
      executable: call.executable,
      argv: [...call.argv],
      cwd: call.cwd,
      original,
      eventIndex: toolEvents.length + callIndex,
      segmentIndex: 0,
      start: 0,
      end: original.length,
      cliMockCallIndex: callIndex,
      cliMockEventPaired: false,
    });
  });

  return observed;
}

function commandSignature(executable: string, argv: readonly string[]): string {
  return JSON.stringify([executable, argv]);
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function commandMatchesAssertion(
  observed: ObservedCommand,
  assertion: CommandCalledStep | CommandNotCalledStep,
): boolean {
  if (observed.executable !== assertion.executable) return false;
  if (assertion.command === undefined) return true;
  return commandMatchesMatcher(observed, assertion.command);
}

export function describeCommandStep(step: CommandCalledStep): string {
  if (step.command === undefined) return `command.called(${step.executable})`;
  return `command.called(${step.executable}, ${describeCommandMatcher(step.command)})`;
}

export function describeObservedCommand(command: ObservedCommand): string {
  return [command.executable, ...command.argv].join(' ');
}

function commandMatchesMatcher(
  observed: ObservedCommand,
  matcher: CommandMatcher,
): boolean {
  if (matcher.args !== undefined) {
    for (const arg of matcher.args) {
      if (!observed.argv.includes(arg)) return false;
    }
  }

  if (
    matcher.argsInOrder !== undefined &&
    !argsAppearInOrder(observed.argv, matcher.argsInOrder)
  ) {
    return false;
  }

  if (matcher.argsMatching !== undefined) {
    for (const expected of matcher.argsMatching) {
      if (!observed.argv.some((arg) => regexMatches(expected, arg))) {
        return false;
      }
    }
  }

  if (
    matcher.originalIncludes !== undefined &&
    !observed.original.includes(matcher.originalIncludes)
  ) {
    return false;
  }

  if (
    matcher.originalMatches !== undefined &&
    !regexMatches(matcher.originalMatches, observed.original)
  ) {
    return false;
  }

  return true;
}

function argsAppearInOrder(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  let cursor = 0;
  for (const expectedArg of expected) {
    const index = actual.indexOf(expectedArg, cursor);
    if (index === -1) return false;
    cursor = index + 1;
  }
  return true;
}

const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh']);
const GROUP_CLOSE_FOR: Record<string, string> = {
  '(': ')',
  '{': '}',
};

function parseCommand(
  command: string,
  event: ToolEvent,
  eventIndex: number,
  segmentStart: number,
  shell?: string,
  depth = 0,
  sourceOffset = 0,
): ObservedCommand[] {
  if (depth > 2) return [];

  const commands: ObservedCommand[] = [];
  let segmentIndex = segmentStart;

  for (const segment of splitCommandSegments(command)) {
    // Unwrap a whole-segment `(…)` / `{…}`, then re-parse so inner separators
    // become normal top-level splits.
    const grouping = unwrapShellGrouping(segment.command);
    if (grouping !== undefined) {
      const nested = parseCommand(
        grouping.command,
        event,
        eventIndex,
        segmentIndex,
        shell,
        depth,
        sourceOffset + segment.start + grouping.offset,
      );
      commands.push(...nested);
      segmentIndex += Math.max(1, nested.length);
      continue;
    }

    const parsed = parseSegment(segment.command);
    if (parsed === undefined) continue;

    const shellCommand = shellWrappedCommand(parsed);
    if (shellCommand !== undefined) {
      // Nested commands are parsed from the *unquoted* `-c` argument, so their
      // `start`/`end` are re-based onto the outer string via `sourceOffset`.
      // These offsets underestimate the true raw position by a constant: the
      // wrapper preamble (`bash -c "`) that precedes the inner string. Because
      // that shift is constant within a wrapper, the relative ordering of all
      // observed commands (nested and top-level) is preserved — which is all
      // the sequence cursor relies on. Known edge: a `tool.called` shell
      // substring matcher uses exact raw offsets, so if its match ends within
      // ~preamble-length characters just before a nested command, that command
      // step can be skipped. Rare in practice; see docs/config-authoring.md.
      const nested = parseCommand(
        shellCommand.command,
        event,
        eventIndex,
        segmentIndex,
        shellCommand.shell,
        depth + 1,
        sourceOffset + segment.start,
      );
      commands.push(...nested);
      segmentIndex += Math.max(1, nested.length);
      continue;
    }

    const cwdFlag = cwdFromGitArgs(parsed.executable, parsed.argv);
    const cwd = cwdFromInput(event.input);
    commands.push({
      toolCallId: `${eventIndex}`,
      executable: parsed.executable,
      ...(parsed.executablePath === undefined
        ? {}
        : {executablePath: parsed.executablePath}),
      argv: parsed.argv,
      ...(cwd === undefined ? {} : {cwd}),
      ...(cwdFlag === undefined ? {} : {cwdFlag}),
      ...(shell === undefined ? {} : {shell}),
      original: segment.command,
      eventIndex,
      segmentIndex,
      start: sourceOffset + segment.start,
      end: sourceOffset + segment.end,
    });
    segmentIndex += 1;
  }

  return commands;
}

/**
 * If `command` is one outer subshell `(…)` or brace group `{…}`, optionally
 * followed only by redirections (e.g. `2>&1`, `>out`), return the inner text
 * and its offset within `command`.
 */
function unwrapShellGrouping(
  command: string,
): {command: string; offset: number} | undefined {
  const start = command.match(/^\s*/)?.[0].length ?? 0;
  if (start >= command.length) return undefined;

  const open = command[start]!;
  const close = GROUP_CLOSE_FOR[open];
  if (close === undefined) return undefined;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let closeIndex = -1;

  for (let index = start; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === '\\' && !inSingle) {
      index += 1;
      continue;
    }
    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        break;
      }
      if (depth < 0) return undefined;
    }
  }

  if (closeIndex === -1 || inSingle || inDouble) return undefined;
  // Allow only redirections after the group closer so shapes like
  // `(cmd; echo done) >out` and `{ cmd; } 2>&1` still unwrap.
  if (!isTrailingRedirectionOnly(command.slice(closeIndex + 1))) {
    return undefined;
  }

  return {
    command: command.slice(start + 1, closeIndex),
    offset: start + 1,
  };
}

/**
 * True when `suffix` is empty/whitespace or only shell redirections
 * (`2>&1`, `>out`, `>>log`, `<in`, etc.), not another command.
 */
function isTrailingRedirectionOnly(suffix: string): boolean {
  let index = 0;
  while (index < suffix.length && /\s/.test(suffix[index]!)) index += 1;
  if (index >= suffix.length) return true;

  while (index < suffix.length) {
    while (index < suffix.length && /\s/.test(suffix[index]!)) index += 1;
    if (index >= suffix.length) return true;

    // Optional fd number before the operator (e.g. `2>` in `2>&1`).
    if (/\d/.test(suffix[index]!)) {
      while (index < suffix.length && /\d/.test(suffix[index]!)) index += 1;
    }

    const rest = suffix.slice(index);
    const operatorLength = redirectionOperatorLength(rest);
    if (operatorLength === undefined) return false;
    index += operatorLength;

    while (index < suffix.length && /\s/.test(suffix[index]!)) index += 1;
    if (index >= suffix.length) return false;

    // Target: `&1` / `word` (stop at shell metacharacters).
    if (suffix[index] === '&') {
      index += 1;
      if (index >= suffix.length || !/\d/.test(suffix[index]!)) return false;
      while (index < suffix.length && /\d/.test(suffix[index]!)) index += 1;
      continue;
    }

    const targetStart = index;
    while (index < suffix.length && !/[\s;&|<>(){}]/.test(suffix[index]!)) {
      index += 1;
    }
    if (index === targetStart) return false;
  }

  return true;
}

/** Length of a leading redirection operator in `text`, or undefined if none. */
function redirectionOperatorLength(text: string): number | undefined {
  if (text.startsWith('&>>')) return 3;
  if (
    text.startsWith('<&') ||
    text.startsWith('>&') ||
    text.startsWith('>>') ||
    text.startsWith('<<') ||
    text.startsWith('&>') ||
    text.startsWith('<>') ||
    text.startsWith('>|')
  ) {
    return 2;
  }
  if (text.startsWith('>') || text.startsWith('<')) return 1;
  return undefined;
}

function parseSegment(
  segment: string,
): {executable: string; executablePath?: string; argv: string[]} | undefined {
  const tokens = commandTokens(segment.trim());
  if (tokens.length === 0) return undefined;

  const executableToken = tokens[0]!;
  const executable = basename(executableToken);
  return {
    executable,
    ...(executable === executableToken
      ? {}
      : {executablePath: executableToken}),
    argv: tokens.slice(1),
  };
}

function shellWrappedCommand(parsed: {
  executable: string;
  executablePath?: string;
  argv: string[];
}): {shell: string; command: string} | undefined {
  if (!SHELL_WRAPPERS.has(parsed.executable)) return undefined;

  const commandFlagIndex = parsed.argv.findIndex((arg) =>
    /^-[A-Za-z]*c$/.test(arg),
  );
  if (commandFlagIndex === -1) return undefined;

  const command = parsed.argv[commandFlagIndex + 1];
  if (command === undefined) return undefined;
  return {shell: parsed.executablePath ?? parsed.executable, command};
}

function splitCommandSegments(
  command: string,
): {command: string; start: number; end: number}[] {
  const segments: {command: string; start: number; end: number}[] = [];
  let current = '';
  let currentStart = 0;
  let inSingle = false;
  let inDouble = false;
  // Expected closers for open `(…)` / `{…}` groups. Separators only split when
  // this is empty; groups are unwrapped later in parseCommand.
  const groupStack: string[] = [];

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (char === '\\' && !inSingle) {
      current += char;
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }

    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (inSingle || inDouble) {
      current += char;
      continue;
    }

    const expectedClose = GROUP_CLOSE_FOR[char];
    if (expectedClose !== undefined) {
      groupStack.push(expectedClose);
      current += char;
      continue;
    }
    if (groupStack.length > 0 && char === groupStack[groupStack.length - 1]) {
      groupStack.pop();
      current += char;
      continue;
    }

    // Two-char separators before single-char `|` so `||` / `|&` are not split
    // as empty pipe stages. Bare `&` is intentionally not a separator.
    const twoChar = next === undefined ? '' : `${char}${next}`;
    if (
      groupStack.length === 0 &&
      (twoChar === '&&' || twoChar === '||' || twoChar === '|&')
    ) {
      pushCommandSegment(segments, current, currentStart, index);
      current = '';
      index += 1;
      currentStart = index + 1;
      continue;
    }

    if (groupStack.length === 0 && (char === ';' || char === '|')) {
      pushCommandSegment(segments, current, currentStart, index);
      current = '';
      currentStart = index + 1;
      continue;
    }

    current += char;
  }

  pushCommandSegment(segments, current, currentStart, command.length);
  return segments;
}

function pushCommandSegment(
  segments: {command: string; start: number; end: number}[],
  raw: string,
  rawStart: number,
  rawEnd: number,
): void {
  const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const start = rawStart + leadingWhitespace;
  segments.push({command: trimmed, start, end: Math.max(start, rawEnd)});
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  const entries = parseCommandEntries(command);

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry.length > 0) tokens.push(entry);
      continue;
    }

    if (isGlobEntry(entry)) {
      tokens.push(entry.pattern);
      continue;
    }

    break;
  }

  return withoutLeadingEnvAssignments(tokens);
}

function parseCommandEntries(command: string): ParseEntry[] {
  try {
    return parseShellCommand(
      preserveUnquotedHashes(command),
      preserveShellVariable,
    );
  } catch {
    return command.split(/\s+/).filter(Boolean);
  }
}

function preserveShellVariable(key: string): string {
  return key.length === 0 ? '$' : `$${key}`;
}

function isGlobEntry(entry: Exclude<ParseEntry, string>): entry is {
  op: 'glob';
  pattern: string;
} {
  return 'op' in entry && entry.op === 'glob';
}

function withoutLeadingEnvAssignments(tokens: readonly string[]): string[] {
  const executableIndex = tokens.findIndex(
    (token) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token),
  );
  return executableIndex === -1 ? [] : [...tokens.slice(executableIndex)];
}

function preserveUnquotedHashes(command: string): string {
  let result = '';
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (char === '\\' && quote !== 'single') {
      result += char;
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }

    if (quote === undefined && char === "'") {
      quote = 'single';
      result += char;
      continue;
    }
    if (quote === 'single' && char === "'") {
      quote = undefined;
      result += char;
      continue;
    }
    if (quote === undefined && char === '"') {
      quote = 'double';
      result += char;
      continue;
    }
    if (quote === 'double' && char === '"') {
      quote = undefined;
      result += char;
      continue;
    }

    if (quote === undefined && char === '#') {
      // An unquoted '#' at a word boundary starts a shell comment: drop the
      // rest of the segment so commented-out text is not parsed as argv. A
      // mid-word '#' (e.g. owner/repo#123) is literal, so escape it to stop
      // shell-quote from treating it as a comment.
      if (index === 0 || /\s/.test(command[index - 1]!)) break;
      result += '\\#';
      continue;
    }

    result += char;
  }

  return result;
}

function cwdFromGitArgs(
  executable: string,
  argv: readonly string[],
): string | undefined {
  if (executable !== 'git') return undefined;
  const index = argv.indexOf('-C');
  return index === -1 ? undefined : argv[index + 1];
}

function cwdFromInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.cwd === 'string') return record.cwd;
  if (typeof record.workdir === 'string') return record.workdir;
  if (typeof record.workDir === 'string') return record.workDir;
  return undefined;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

const revivedRegexCache = new WeakMap<
  {source: string; flags: string},
  RegExp
>();

function reviveRegex(pattern: {source: string; flags: string}): RegExp {
  const cached = revivedRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  const regex = new RegExp(pattern.source, pattern.flags);
  revivedRegexCache.set(pattern, regex);
  return regex;
}

function regexMatches(
  pattern: {source: string; flags: string},
  value: string,
): boolean {
  const regex = reviveRegex(pattern);
  regex.lastIndex = 0;
  return regex.test(value);
}

function commandCalledFailMessage(
  assertion: CommandCalledAssertion,
  observed: readonly ObservedCommand[],
  rawShellMatches: readonly string[],
): string {
  const sameExecutable = observed.filter(
    (command) => command.executable === assertion.executable,
  );
  const observedLines =
    observed.length === 0
      ? '  (none)'
      : observed
          .map(
            (command, index) =>
              `  ${index + 1}. ${describeObservedCommand(command)}`,
          )
          .join('\n');
  const details = commandMatcherFailureDetail(
    assertion,
    sameExecutable,
    rawShellMatches,
  );
  return `Expected command:\n  ${describeExpectedCommand(assertion)}\nObserved commands:\n${observedLines}${details === undefined ? '' : `\n${details}`}`;
}

function commandMatcherFailureDetail(
  assertion: CommandCalledAssertion,
  sameExecutable: readonly ObservedCommand[],
  rawShellMatches: readonly string[],
): string | undefined {
  if (sameExecutable.length === 0) {
    if (rawShellMatches.length === 0) {
      return `No observed ${assertion.executable} command.`;
    }

    const rawLines = rawShellMatches
      .map((command) => `  - ${command}`)
      .join('\n');
    return [
      `No normalized ${assertion.executable} command was observed.`,
      `Raw shell events included text matching "${assertion.executable}"; command normalization may not support this shell shape.`,
      'Raw shell matches:',
      rawLines,
    ].join('\n');
  }
  const matcher = assertion.command;
  if (matcher?.args !== undefined) {
    const missing = matcher.args.find((arg) =>
      sameExecutable.every((command) => !command.argv.includes(arg)),
    );
    if (missing !== undefined) {
      return `No observed ${assertion.executable} command included arg "${missing}".`;
    }
  }
  return `No observed ${assertion.executable} command matched ${describeCommandMatcher(matcher)}.`;
}

/** Collect raw shell command strings that mention an executable name. */
function rawShellCommandsMatching(
  toolEvents: readonly ToolEvent[],
  executable: string,
): string[] {
  const matches: string[] = [];
  for (const event of toolEvents) {
    if (event.kind !== 'shell' || typeof event.command !== 'string') continue;
    if (!rawShellTextMentionsExecutable(event.command, executable)) continue;
    matches.push(event.command);
  }
  return matches;
}

/**
 * True when raw shell text appears to mention `executable` as a command word
 * (word-boundary style), not merely as a substring of another token.
 */
function rawShellTextMentionsExecutable(
  command: string,
  executable: string,
): boolean {
  if (executable.length === 0) return false;
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped}([^A-Za-z0-9_.-]|$)`).test(
    command,
  );
}

function describeExpectedCommand(
  assertion: CommandCalledStep | CommandNotCalledStep,
): string {
  if (assertion.command === undefined) return assertion.executable;
  return `${assertion.executable} with ${describeCommandMatcher(assertion.command)}`;
}
