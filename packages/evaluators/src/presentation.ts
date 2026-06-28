import type {ShellCommandMatcher} from '@dynobox/sdk';
import type {IrAssertion} from '@dynobox/sdk/ir';

export type MatcherPresentationStyle = 'message' | 'compact' | 'expectation';

export type ShellCommandMatcherEntry =
  | {strategy: 'equals'; value: string}
  | {strategy: 'includes'; value: string}
  | {strategy: 'startsWith'; value: string}
  | {strategy: 'matches'; value: string};

type CommandMatcher = NonNullable<
  Extract<IrAssertion, {type: 'command.called'}>['command']
>;

export function shellCommandMatcherEntry(
  matcher: ShellCommandMatcher,
): ShellCommandMatcherEntry | undefined {
  if ('equals' in matcher && typeof matcher.equals === 'string') {
    return {strategy: 'equals', value: matcher.equals};
  }
  if ('includes' in matcher && typeof matcher.includes === 'string') {
    return {strategy: 'includes', value: matcher.includes};
  }
  if ('startsWith' in matcher && typeof matcher.startsWith === 'string') {
    return {strategy: 'startsWith', value: matcher.startsWith};
  }
  if ('matches' in matcher && typeof matcher.matches === 'string') {
    return {strategy: 'matches', value: matcher.matches};
  }
  return undefined;
}

export function describeShellCommandMatcher(
  matcher: ShellCommandMatcher,
  options: {style?: MatcherPresentationStyle} = {},
): string {
  const style = options.style ?? 'message';
  const entry = shellCommandMatcherEntry(matcher);
  if (entry === undefined) {
    return style === 'expectation'
      ? 'shell command matching the requested matcher'
      : 'the requested matcher';
  }

  if (style === 'compact') {
    return `${entry.strategy}: ${entry.value}`;
  }

  if (style === 'expectation') {
    if (entry.strategy === 'equals') {
      return `shell command equal to "${entry.value}"`;
    }
    if (entry.strategy === 'includes') {
      return `shell command including "${entry.value}"`;
    }
    if (entry.strategy === 'startsWith') {
      return `shell command starting with "${entry.value}"`;
    }
    return `shell command matching /${entry.value}/`;
  }

  if (entry.strategy === 'matches') return `matches /${entry.value}/`;
  return `${entry.strategy} "${entry.value}"`;
}

export function describeCommandMatcher(
  matcher: CommandMatcher | undefined,
  options: {style?: MatcherPresentationStyle} = {},
): string {
  if (matcher === undefined) return 'any args';

  const style = options.style ?? 'message';
  const separator = style === 'message' ? ' ' : ': ';
  const quoteOriginalIncludes = style === 'message';
  const parts: string[] = [];

  if (matcher.args !== undefined) {
    parts.push(`args${separator}${JSON.stringify(matcher.args)}`);
  }
  if (matcher.argsInOrder !== undefined) {
    parts.push(`argsInOrder${separator}${JSON.stringify(matcher.argsInOrder)}`);
  }
  if (matcher.argsMatching !== undefined) {
    parts.push(
      `argsMatching${separator}${matcher.argsMatching.map((pattern) => `/${pattern.source}/${pattern.flags}`).join(', ')}`,
    );
  }
  if (matcher.originalIncludes !== undefined) {
    const value = quoteOriginalIncludes
      ? `"${matcher.originalIncludes}"`
      : matcher.originalIncludes;
    parts.push(`originalIncludes${separator}${value}`);
  }
  if (matcher.originalMatches !== undefined) {
    parts.push(
      `originalMatches${separator}/${matcher.originalMatches.source}/${matcher.originalMatches.flags}`,
    );
  }
  return parts.join(', ');
}
