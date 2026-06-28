import {describe, expect, it} from 'vitest';

import {
  describeCommandMatcher,
  describeShellCommandMatcher,
  shellCommandMatcherEntry,
} from './presentation.js';

describe('shellCommandMatcherEntry', () => {
  it('returns the matcher strategy and value', () => {
    expect(shellCommandMatcherEntry({equals: 'pnpm test'})).toEqual({
      strategy: 'equals',
      value: 'pnpm test',
    });
    expect(shellCommandMatcherEntry({includes: 'pnpm'})).toEqual({
      strategy: 'includes',
      value: 'pnpm',
    });
    expect(shellCommandMatcherEntry({startsWith: 'pnpm'})).toEqual({
      strategy: 'startsWith',
      value: 'pnpm',
    });
    expect(shellCommandMatcherEntry({matches: '^pnpm'})).toEqual({
      strategy: 'matches',
      value: '^pnpm',
    });
  });
});

describe('describeShellCommandMatcher', () => {
  it('describes message style matchers', () => {
    expect(describeShellCommandMatcher({equals: 'pnpm test'})).toBe(
      'equals "pnpm test"',
    );
    expect(describeShellCommandMatcher({includes: 'pnpm'})).toBe(
      'includes "pnpm"',
    );
    expect(describeShellCommandMatcher({startsWith: 'pnpm'})).toBe(
      'startsWith "pnpm"',
    );
    expect(describeShellCommandMatcher({matches: '^pnpm'})).toBe(
      'matches /^pnpm/',
    );
  });

  it('describes compact style matchers', () => {
    expect(
      describeShellCommandMatcher({equals: 'pnpm test'}, {style: 'compact'}),
    ).toBe('equals: pnpm test');
    expect(
      describeShellCommandMatcher({includes: 'pnpm'}, {style: 'compact'}),
    ).toBe('includes: pnpm');
    expect(
      describeShellCommandMatcher({startsWith: 'pnpm'}, {style: 'compact'}),
    ).toBe('startsWith: pnpm');
    expect(
      describeShellCommandMatcher({matches: '^pnpm'}, {style: 'compact'}),
    ).toBe('matches: ^pnpm');
  });

  it('describes expectation style matchers', () => {
    expect(
      describeShellCommandMatcher(
        {equals: 'pnpm test'},
        {style: 'expectation'},
      ),
    ).toBe('shell command equal to "pnpm test"');
    expect(
      describeShellCommandMatcher({includes: 'pnpm'}, {style: 'expectation'}),
    ).toBe('shell command including "pnpm"');
    expect(
      describeShellCommandMatcher({startsWith: 'pnpm'}, {style: 'expectation'}),
    ).toBe('shell command starting with "pnpm"');
    expect(
      describeShellCommandMatcher({matches: '^pnpm'}, {style: 'expectation'}),
    ).toBe('shell command matching /^pnpm/');
  });
});

describe('describeCommandMatcher', () => {
  const matcher = {
    args: ['--run'],
    argsInOrder: ['test', '--run'],
    argsMatching: [{source: '^--filter', flags: 'i'}],
    originalIncludes: 'pnpm test',
    originalMatches: {source: '^pnpm', flags: ''},
  };

  it('describes message style command matchers', () => {
    expect(describeCommandMatcher(matcher)).toBe(
      'args ["--run"], argsInOrder ["test","--run"], argsMatching /^--filter/i, originalIncludes "pnpm test", originalMatches /^pnpm/',
    );
  });

  it('describes compact style command matchers', () => {
    expect(describeCommandMatcher(matcher, {style: 'compact'})).toBe(
      'args: ["--run"], argsInOrder: ["test","--run"], argsMatching: /^--filter/i, originalIncludes: pnpm test, originalMatches: /^pnpm/',
    );
  });

  it('keeps the existing no-matcher message text', () => {
    expect(describeCommandMatcher(undefined)).toBe('any args');
  });
});
