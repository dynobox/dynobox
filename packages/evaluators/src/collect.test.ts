import {describe, expect, it} from 'vitest';

import type {IrAssertion} from '@dynobox/sdk/ir';

import {
  anyOfBranchId,
  assertionRequiresVerify,
  collectArtifactUnchangedTargets,
  collectVerifyCommandAssertions,
} from './collect.js';

describe('collect helpers', () => {
  it('collects top-level and nested verify commands with stable branch ids', () => {
    const assertions: IrAssertion[] = [
      {
        id: 'assertion.verify.0',
        type: 'verify.command',
        command: 'pnpm test',
        exitCode: 0,
      },
      {
        id: 'assertion.any.0',
        type: 'anyOf',
        steps: [
          {type: 'artifact.exists', path: 'a.txt'},
          {
            type: 'verify.command',
            command: 'pnpm lint',
            exitCode: 0,
          },
          {
            type: 'verify.command',
            command: 'pnpm build',
            stdout: {includes: 'done'},
          },
        ],
      },
    ];

    expect(collectVerifyCommandAssertions(assertions)).toEqual([
      {
        id: 'assertion.verify.0',
        type: 'verify.command',
        command: 'pnpm test',
        exitCode: 0,
      },
      {
        id: anyOfBranchId('assertion.any.0', 2),
        type: 'verify.command',
        command: 'pnpm lint',
        exitCode: 0,
      },
      {
        id: anyOfBranchId('assertion.any.0', 3),
        type: 'verify.command',
        command: 'pnpm build',
        stdout: {includes: 'done'},
      },
    ]);
  });

  it('collects unchanged targets from top-level and anyOf branches', () => {
    const assertions: IrAssertion[] = [
      {
        id: 'assertion.keep.0',
        type: 'artifact.unchanged',
        path: 'package.json',
      },
      {
        id: 'assertion.any.0',
        type: 'anyOf',
        steps: [
          {type: 'artifact.unchanged', path: 'lock.yaml'},
          {type: 'artifact.exists', path: 'out.txt'},
        ],
      },
    ];

    expect(collectArtifactUnchangedTargets(assertions)).toEqual([
      {assertionId: 'assertion.keep.0', path: 'package.json'},
      {
        assertionId: anyOfBranchId('assertion.any.0', 1),
        path: 'lock.yaml',
      },
    ]);
  });

  it('detects assertions that require verification results', () => {
    expect(
      assertionRequiresVerify({
        id: 'a',
        type: 'verify.command',
        command: 'true',
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      assertionRequiresVerify({
        id: 'b',
        type: 'anyOf',
        steps: [
          {type: 'artifact.exists', path: 'a.txt'},
          {type: 'verify.command', command: 'true', exitCode: 0},
        ],
      }),
    ).toBe(true);
    expect(
      assertionRequiresVerify({
        id: 'c',
        type: 'anyOf',
        steps: [{type: 'artifact.exists', path: 'a.txt'}],
      }),
    ).toBe(false);
  });
});
