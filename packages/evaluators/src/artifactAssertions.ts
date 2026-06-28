import {existsSync, readFileSync} from 'node:fs';

import type {IrAssertion} from '@dynobox/sdk/ir';

import {type ArtifactInspection, resolveArtifactPath} from './inspection.js';
import {failed, passed} from './results.js';
import type {AssertionResult} from './types.js';

export function evaluateArtifactExists(
  assertion: Extract<IrAssertion, {type: 'artifact.exists'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failedWithEvidence(assertion, resolved.error, {
      kind: 'invalid',
      message: resolved.error,
    });
  }

  if (existsSync(resolved.path)) {
    return passed(assertion, `Artifact "${assertion.path}" exists.`, {
      kind: 'exists',
      path: resolved.path,
    });
  }

  return failedWithEvidence(
    assertion,
    `Expected artifact "${assertion.path}" to exist.`,
    {kind: 'missing', path: resolved.path},
  );
}

export function evaluateArtifactContains(
  assertion: Extract<IrAssertion, {type: 'artifact.contains'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failedWithEvidence(assertion, resolved.error, {
      kind: 'invalid',
      message: resolved.error,
    });
  }

  try {
    const contents = readFileSync(resolved.path, 'utf8');
    if (contents.includes(assertion.text)) {
      return passed(
        assertion,
        `Artifact "${assertion.path}" contains expected text.`,
        {kind: 'exists', path: resolved.path},
      );
    }

    return failedWithEvidence(
      assertion,
      `Expected artifact "${assertion.path}" to contain "${assertion.text}".`,
      {kind: 'exists', path: resolved.path, contents},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedWithEvidence(
      assertion,
      `Could not read artifact "${assertion.path}" as UTF-8: ${message}`,
      existsSync(resolved.path)
        ? {kind: 'exists', path: resolved.path}
        : {kind: 'missing', path: resolved.path},
    );
  }
}

function failedWithEvidence(
  assertion: Pick<IrAssertion, 'id' | 'type'>,
  message: string,
  evidence: ArtifactInspection,
): AssertionResult {
  return {...failed(assertion, message), evidence};
}
