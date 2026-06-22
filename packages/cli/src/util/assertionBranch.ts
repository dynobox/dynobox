import type {IrAssertion} from '@dynobox/sdk/ir';

export type IrAnyOfBranch = Extract<
  IrAssertion,
  {kind: 'anyOf'}
>['steps'][number];

const ASSERTION_BRANCH_ID = 'assertion.branch';

export function assertionBranchWithId(assertion: IrAnyOfBranch): IrAssertion {
  return {
    id: ASSERTION_BRANCH_ID,
    ...(assertion as Record<string, unknown>),
  } as IrAssertion;
}
