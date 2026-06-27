import {type IrAssertion, irAssertionFromNode} from '@dynobox/sdk/ir';

export type IrAnyOfBranch = Extract<
  IrAssertion,
  {kind: 'anyOf'}
>['steps'][number];

const ASSERTION_BRANCH_ID = 'assertion.branch';

export function assertionBranchWithId(assertion: IrAnyOfBranch): IrAssertion {
  // Branches have no IDs in IR; this placeholder is only used for description.
  return irAssertionFromNode(ASSERTION_BRANCH_ID, assertion);
}

type AnyOfBranchResult = {passed: boolean; message: string};

export function anyOfMatchedBranch(evidence: unknown): number | undefined {
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  if (!('kind' in evidence) || evidence.kind !== 'anyOf') return undefined;
  if (!('branchIndex' in evidence)) return undefined;
  return typeof evidence.branchIndex === 'number'
    ? evidence.branchIndex
    : undefined;
}

export function anyOfBranchResults(
  evidence: unknown,
): readonly AnyOfBranchResult[] | undefined {
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  if (!('kind' in evidence) || evidence.kind !== 'anyOf') return undefined;
  if (!('branches' in evidence) || !Array.isArray(evidence.branches)) {
    return undefined;
  }
  if (
    !evidence.branches.every(
      (branch): branch is AnyOfBranchResult =>
        typeof branch === 'object' &&
        branch !== null &&
        'passed' in branch &&
        typeof branch.passed === 'boolean' &&
        'message' in branch &&
        typeof branch.message === 'string',
    )
  ) {
    return undefined;
  }
  return evidence.branches;
}
