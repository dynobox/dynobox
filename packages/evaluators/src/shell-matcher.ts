import type {ShellToolMatcher} from '@dynobox/sdk';

export type ShellMatcherResult = {
  passed: boolean;
  error?: string;
};

export type ShellMatcherPositionResult =
  | {
      passed: true;
      start: number;
      end: number;
    }
  | {
      passed: false;
      error?: string;
    };

export function shellCommandMatches(
  command: string,
  matcher: ShellToolMatcher,
): ShellMatcherResult {
  if ('equals' in matcher && typeof matcher.equals === 'string') {
    return {passed: command === matcher.equals};
  }
  if ('includes' in matcher && typeof matcher.includes === 'string') {
    return {passed: command.includes(matcher.includes)};
  }
  if ('startsWith' in matcher && typeof matcher.startsWith === 'string') {
    return {passed: command.startsWith(matcher.startsWith)};
  }
  if ('matches' in matcher && typeof matcher.matches === 'string') {
    try {
      return {passed: new RegExp(matcher.matches).test(command)};
    } catch (error) {
      return {
        passed: false,
        error: invalidRegexMessage(matcher.matches, error),
      };
    }
  }
  return {passed: false};
}

export function shellCommandMatchPosition(
  command: string,
  matcher: ShellToolMatcher,
  startAt = 0,
): ShellMatcherPositionResult {
  const offset = Math.max(0, startAt);

  if ('equals' in matcher && typeof matcher.equals === 'string') {
    if (offset !== 0 || command !== matcher.equals) return {passed: false};
    return passedPosition(0, command.length, command.length);
  }

  if ('includes' in matcher && typeof matcher.includes === 'string') {
    const start = command.indexOf(matcher.includes, offset);
    if (start === -1) return {passed: false};
    return passedPosition(start, start + matcher.includes.length, command.length);
  }

  if ('startsWith' in matcher && typeof matcher.startsWith === 'string') {
    if (offset !== 0 || !command.startsWith(matcher.startsWith)) {
      return {passed: false};
    }
    return passedPosition(0, matcher.startsWith.length, command.length);
  }

  if ('matches' in matcher && typeof matcher.matches === 'string') {
    try {
      const match = new RegExp(matcher.matches).exec(command.slice(offset));
      if (match === null || match.index === undefined) return {passed: false};
      const start = offset + match.index;
      return passedPosition(start, start + match[0].length, command.length);
    } catch (error) {
      return {
        passed: false,
        error: invalidRegexMessage(matcher.matches, error),
      };
    }
  }

  return {passed: false};
}

export function validateRegexMatcher(
  matcher: ShellToolMatcher,
): string | undefined {
  if (!('matches' in matcher) || typeof matcher.matches !== 'string') {
    return undefined;
  }

  try {
    new RegExp(matcher.matches);
    return undefined;
  } catch (error) {
    return invalidRegexMessage(matcher.matches, error);
  }
}

export function describeShellMatcher(matcher: ShellToolMatcher): string {
  if ('equals' in matcher && typeof matcher.equals === 'string') {
    return `equals "${matcher.equals}"`;
  }
  if ('includes' in matcher && typeof matcher.includes === 'string') {
    return `includes "${matcher.includes}"`;
  }
  if ('startsWith' in matcher && typeof matcher.startsWith === 'string') {
    return `startsWith "${matcher.startsWith}"`;
  }
  if ('matches' in matcher && typeof matcher.matches === 'string') {
    return `matches /${matcher.matches}/`;
  }
  return 'the requested matcher';
}

function invalidRegexMessage(pattern: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Invalid shell matcher regex "${pattern}": ${detail}`;
}

function passedPosition(
  start: number,
  end: number,
  commandLength: number,
): ShellMatcherPositionResult {
  return {
    passed: true,
    start,
    end: end === start ? Math.min(commandLength, end + 1) : end,
  };
}
