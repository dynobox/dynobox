import type {ShellToolMatcher} from '@dynobox/sdk';

export type ShellMatcherResult = {
  passed: boolean;
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
