import type {IrAssertion} from '@dynobox/sdk/ir';

/**
 * Synthetic branch id used for nested anyOf evaluation and diagnostics.
 *
 * Uses `#branch:` so the id cannot collide with compiled top-level assertion
 * ids (`assertion.<slug>.<suffix>`), whose suffixes only allow `[A-Za-z0-9._-]`.
 */
export function anyOfBranchId(anyOfId: string, branchIndex: number): string {
  return `${anyOfId}#branch:${branchIndex}`;
}

type VerifyCommandAssertion = Extract<IrAssertion, {type: 'verify.command'}>;

/**
 * Collect top-level and nested `verify.command` assertions in authored order.
 * Nested branches receive stable synthetic ids (`${anyOfId}#branch:${n}`).
 */
export function collectVerifyCommandAssertions(
  assertions: readonly IrAssertion[],
): VerifyCommandAssertion[] {
  const collected: VerifyCommandAssertion[] = [];

  for (const assertion of assertions) {
    if (assertion.type === 'verify.command') {
      collected.push(assertion);
      continue;
    }

    if (assertion.type !== 'anyOf') continue;

    assertion.steps.forEach((step, index) => {
      if (step.type !== 'verify.command') return;
      // Branch nodes are authored without ids; attach a stable synthetic id.
      // Spread step first so the synthetic id always wins.
      collected.push({
        ...(step as Omit<VerifyCommandAssertion, 'id' | 'label'>),
        id: anyOfBranchId(assertion.id, index + 1),
      } as VerifyCommandAssertion);
    });
  }

  return collected;
}

/** Path targets for `artifact.unchanged`, including nested anyOf branches. */
export type ArtifactUnchangedTarget = {
  assertionId: string;
  path: string;
};

/**
 * Find every `artifact.unchanged` assertion, including those nested in anyOf.
 */
export function collectArtifactUnchangedTargets(
  assertions: readonly IrAssertion[],
): ArtifactUnchangedTarget[] {
  const targets: ArtifactUnchangedTarget[] = [];

  for (const assertion of assertions) {
    if (assertion.type === 'artifact.unchanged') {
      targets.push({assertionId: assertion.id, path: assertion.path});
      continue;
    }

    if (assertion.type !== 'anyOf') continue;

    assertion.steps.forEach((step, index) => {
      if (!isArtifactUnchangedNode(step)) return;
      targets.push({
        assertionId: anyOfBranchId(assertion.id, index + 1),
        path: step.path,
      });
    });
  }

  return targets;
}

function isArtifactUnchangedNode(step: {
  type: string;
}): step is {type: 'artifact.unchanged'; path: string} {
  return (
    step.type === 'artifact.unchanged' &&
    'path' in step &&
    typeof (step as {path?: unknown}).path === 'string'
  );
}

/** True when an anyOf assertion includes at least one verify.command branch. */
export function anyOfHasVerifyBranch(
  assertion: Extract<IrAssertion, {type: 'anyOf'}>,
): boolean {
  return assertion.steps.some((step) => step.type === 'verify.command');
}

/**
 * True when assertion evaluation requires verify command results (top-level
 * verify.command, or anyOf with nested verification branches).
 */
export function assertionRequiresVerify(assertion: IrAssertion): boolean {
  if (assertion.type === 'verify.command') return true;
  return assertion.type === 'anyOf' && anyOfHasVerifyBranch(assertion);
}
