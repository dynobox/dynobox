import {existsSync, readFileSync} from 'node:fs';

import type {IrAssertion} from '@dynobox/sdk/ir';

import {resolveArtifactPath} from './inspection.js';
import {failed} from './results.js';
import type {AssertionResult} from './types.js';

export function evaluateArtifactExists(
  assertion: Extract<IrAssertion, {kind: 'artifact.exists'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failed(assertion, resolved.error);
  }

  if (existsSync(resolved.path)) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Artifact "${assertion.path}" exists.`,
      evidence: {path: resolved.path},
    };
  }

  return failed(assertion, `Expected artifact "${assertion.path}" to exist.`);
}

export function evaluateArtifactContains(
  assertion: Extract<IrAssertion, {kind: 'artifact.contains'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failed(assertion, resolved.error);
  }

  try {
    const contents = readFileSync(resolved.path, 'utf8');
    if (contents.includes(assertion.text)) {
      return {
        assertionId: assertion.id,
        kind: assertion.kind,
        passed: true,
        message: `Artifact "${assertion.path}" contains expected text.`,
        evidence: {path: resolved.path},
      };
    }

    return failed(
      assertion,
      `Expected artifact "${assertion.path}" to contain "${assertion.text}".`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(
      assertion,
      `Could not read artifact "${assertion.path}" as UTF-8: ${message}`,
    );
  }
}
