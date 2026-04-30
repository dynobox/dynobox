import {describe, expect, it} from 'vitest';

import {
  describeShellMatcher,
  shellCommandMatches,
  validateRegexMatcher,
} from './shell-matcher.js';

const command = 'pnpm test -- --runInBand';

describe('shellCommandMatches', () => {
  it('evaluates equals matchers', () => {
    expect(
      shellCommandMatches(command, {equals: 'pnpm test -- --runInBand'}),
    ).toEqual({passed: true});
    expect(shellCommandMatches(command, {equals: 'npm test'})).toEqual({
      passed: false,
    });
  });

  it('evaluates includes matchers', () => {
    expect(shellCommandMatches(command, {includes: 'pnpm test'})).toEqual({
      passed: true,
    });
    expect(shellCommandMatches(command, {includes: 'pnpm build'})).toEqual({
      passed: false,
    });
  });

  it('evaluates startsWith matchers', () => {
    expect(shellCommandMatches(command, {startsWith: 'pnpm test'})).toEqual({
      passed: true,
    });
    expect(shellCommandMatches(command, {startsWith: 'npm'})).toEqual({
      passed: false,
    });
  });

  it('evaluates regex matchers', () => {
    expect(shellCommandMatches(command, {matches: '^pnpm\\s+test'})).toEqual({
      passed: true,
    });
    expect(shellCommandMatches(command, {matches: '^npm\\s+test'})).toEqual({
      passed: false,
    });
  });

  it('returns an error for invalid regex matchers', () => {
    const result = shellCommandMatches(command, {matches: '('});

    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/^Invalid shell matcher regex "\("/);
  });
});

describe('validateRegexMatcher', () => {
  it('returns undefined for non-regex and valid regex matchers', () => {
    expect(validateRegexMatcher({includes: 'pnpm'})).toBeUndefined();
    expect(validateRegexMatcher({matches: '^pnpm'})).toBeUndefined();
  });

  it('returns an error message for invalid regex matchers', () => {
    expect(validateRegexMatcher({matches: '('})).toMatch(
      /^Invalid shell matcher regex "\("/,
    );
  });
});

describe('describeShellMatcher', () => {
  it('describes supported shell matchers', () => {
    expect(describeShellMatcher({equals: 'pnpm test'})).toBe(
      'equals "pnpm test"',
    );
    expect(describeShellMatcher({includes: 'pnpm'})).toBe('includes "pnpm"');
    expect(describeShellMatcher({startsWith: 'pnpm'})).toBe(
      'startsWith "pnpm"',
    );
    expect(describeShellMatcher({matches: '^pnpm'})).toBe('matches /^pnpm/');
  });
});
