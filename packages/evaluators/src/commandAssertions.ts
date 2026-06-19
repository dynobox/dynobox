import type {IrAssertion} from '@dynobox/sdk/ir';
import {parse as parseShellCommand, type ParseEntry} from 'shell-quote';

import type {AssertionResult, ToolEvent} from './types.js';

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
};

type CommandCalledAssertion = Extract<IrAssertion, {kind: 'command.called'}>;
type CommandNotCalledAssertion = Extract<
  IrAssertion,
  {kind: 'command.notCalled'}
>;
export type CommandCalledStep = Omit<CommandCalledAssertion, 'id'>;
type CommandNotCalledStep = Omit<CommandNotCalledAssertion, 'id'>;
type CommandMatcher = NonNullable<CommandCalledAssertion['matcher']>;

export function evaluateCommandCalledAssertion(
  assertion: CommandCalledAssertion,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const observed = extractObservedCommands(toolEvents);
  const match = observed.find((command) =>
    commandMatchesAssertion(command, assertion),
  );

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed command ${describeExpectedCommand(assertion)}.`,
      evidence: match,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: false,
    message: commandCalledFailMessage(assertion, observed),
    evidence: observed,
  };
}

export function evaluateCommandNotCalledAssertion(
  assertion: CommandNotCalledAssertion,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const observed = extractObservedCommands(toolEvents);
  const match = observed.find((command) =>
    commandMatchesAssertion(command, assertion),
  );

  if (match !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: false,
      message: `Expected no command ${describeExpectedCommand(assertion)}, but observed a matching command.`,
      evidence: match,
    };
  }

  return {
    assertionId: assertion.id,
    kind: assertion.kind,
    passed: true,
    message: `Observed no command ${describeExpectedCommand(assertion)}.`,
  };
}

export function extractObservedCommands(
  toolEvents: readonly ToolEvent[],
): ObservedCommand[] {
  const observed: ObservedCommand[] = [];
  toolEvents.forEach((event, eventIndex) => {
    if (event.kind !== 'shell' || typeof event.command !== 'string') return;
    observed.push(
      ...parseCommand(event.command, event, eventIndex, observed.length),
    );
  });
  return observed;
}

export function commandMatchesAssertion(
  observed: ObservedCommand,
  assertion: CommandCalledStep | CommandNotCalledStep,
): boolean {
  if (observed.executable !== assertion.executable) return false;
  if (assertion.matcher === undefined) return true;
  return commandMatchesMatcher(observed, assertion.matcher);
}

export function describeCommandStep(step: CommandCalledStep): string {
  if (step.matcher === undefined) return `command.called(${step.executable})`;
  return `command.called(${step.executable}, ${describeCommandMatcher(step.matcher)})`;
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
      const regex = reviveRegex(expected);
      if (!observed.argv.some((arg) => regex.test(arg))) return false;
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
    !reviveRegex(matcher.originalMatches).test(observed.original)
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

  const segments = splitCommandSegments(command);
  const commands: ObservedCommand[] = [];
  let segmentIndex = segmentStart;

  for (const segment of segments) {
    const parsed = parseSegment(segment.command);
    if (parsed === undefined) continue;

    const shellCommand = shellWrappedCommand(parsed);
    if (shellCommand !== undefined) {
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
  if (!new Set(['bash', 'sh', 'zsh']).has(parsed.executable)) return undefined;

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
  let quote: 'single' | 'double' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (char === '\\') {
      current += char;
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }

    if (quote === undefined && char === "'") {
      quote = 'single';
      current += char;
      continue;
    }
    if (quote === 'single' && char === "'") {
      quote = undefined;
      current += char;
      continue;
    }
    if (quote === undefined && char === '"') {
      quote = 'double';
      current += char;
      continue;
    }
    if (quote === 'double' && char === '"') {
      quote = undefined;
      current += char;
      continue;
    }

    if (
      quote === undefined &&
      (char === ';' || `${char}${next}` === '&&' || `${char}${next}` === '||')
    ) {
      pushCommandSegment(segments, current, currentStart, index);
      current = '';
      if (char !== ';') index += 1;
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

    result += quote === undefined && char === '#' ? '\\#' : char;
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

function reviveRegex(pattern: {source: string; flags: string}): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function commandCalledFailMessage(
  assertion: CommandCalledAssertion,
  observed: readonly ObservedCommand[],
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
  const details = commandMatcherFailureDetail(assertion, sameExecutable);
  return `Expected command:\n  ${describeExpectedCommand(assertion)}\nObserved commands:\n${observedLines}${details === undefined ? '' : `\n${details}`}`;
}

function commandMatcherFailureDetail(
  assertion: CommandCalledAssertion,
  sameExecutable: readonly ObservedCommand[],
): string | undefined {
  if (sameExecutable.length === 0) {
    return `No observed ${assertion.executable} command.`;
  }
  const matcher = assertion.matcher;
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

function describeExpectedCommand(
  assertion: CommandCalledStep | CommandNotCalledStep,
): string {
  if (assertion.matcher === undefined) return assertion.executable;
  return `${assertion.executable} with ${describeCommandMatcher(assertion.matcher)}`;
}

function describeCommandMatcher(matcher: CommandMatcher | undefined): string {
  if (matcher === undefined) return 'any args';
  const parts: string[] = [];
  if (matcher.args !== undefined)
    parts.push(`args ${JSON.stringify(matcher.args)}`);
  if (matcher.argsInOrder !== undefined) {
    parts.push(`argsInOrder ${JSON.stringify(matcher.argsInOrder)}`);
  }
  if (matcher.argsMatching !== undefined) {
    parts.push(
      `argsMatching ${matcher.argsMatching.map((pattern) => `/${pattern.source}/${pattern.flags}`).join(', ')}`,
    );
  }
  if (matcher.originalIncludes !== undefined) {
    parts.push(`originalIncludes "${matcher.originalIncludes}"`);
  }
  if (matcher.originalMatches !== undefined) {
    parts.push(
      `originalMatches /${matcher.originalMatches.source}/${matcher.originalMatches.flags}`,
    );
  }
  return parts.join(', ');
}
