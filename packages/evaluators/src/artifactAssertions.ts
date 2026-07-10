import {existsSync, lstatSync, readFileSync, type Stats} from 'node:fs';

import type {IrAssertion} from '@dynobox/sdk/ir';

import {type ArtifactInspection, resolveArtifactPath} from './inspection.js';
import {failed, passed} from './results.js';
import type {
  ArtifactBaseline,
  ArtifactPathState,
  ArtifactUnchangedEvidence,
  AssertionResult,
} from './types.js';

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

export function evaluateArtifactNotExists(
  assertion: Extract<IrAssertion, {type: 'artifact.notExists'}>,
  workDir: string | undefined,
): AssertionResult {
  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return failedWithEvidence(assertion, resolved.error, {
      kind: 'invalid',
      message: resolved.error,
    });
  }

  // Use lstat so dangling symlinks count as present paths.
  try {
    lstatSync(resolved.path);
    return failedWithEvidence(
      assertion,
      `Expected artifact "${assertion.path}" to be absent, but it exists at ${resolved.path}.`,
      {kind: 'exists', path: resolved.path},
    );
  } catch (error) {
    if (isEnoent(error)) {
      return passed(assertion, `Artifact "${assertion.path}" is absent.`, {
        kind: 'missing',
        path: resolved.path,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return failedWithEvidence(
      assertion,
      `Could not inspect artifact "${assertion.path}": ${message}`,
      {kind: 'invalid', message},
    );
  }
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

/**
 * Capture a post-setup baseline for `artifact.unchanged`. Snapshot failures are
 * returned as baseline values so they remain assertion-level later.
 */
export function captureArtifactBaseline(
  path: string,
  workDir: string | undefined,
): ArtifactBaseline {
  const resolved = resolveArtifactPath(path, workDir);
  if (resolved.error !== undefined) {
    return {kind: 'invalid', message: resolved.error};
  }

  try {
    const stats = lstatSync(resolved.path);
    if (stats.isSymbolicLink()) {
      return {
        kind: 'not-file',
        path: resolved.path,
        fileType: 'symlink',
      };
    }
    if (stats.isDirectory()) {
      return {
        kind: 'not-file',
        path: resolved.path,
        fileType: 'directory',
      };
    }
    if (!stats.isFile()) {
      return {
        kind: 'not-file',
        path: resolved.path,
        fileType: 'other',
      };
    }

    const bytes = new Uint8Array(readFileSync(resolved.path));
    return {
      kind: 'file',
      path: resolved.path,
      size: bytes.byteLength,
      bytes,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {kind: 'missing', path: resolved.path};
    }
    const message = error instanceof Error ? error.message : String(error);
    return {kind: 'unreadable', path: resolved.path, message};
  }
}

export function evaluateArtifactUnchanged(
  assertion: Extract<IrAssertion, {type: 'artifact.unchanged'}>,
  workDir: string | undefined,
  baselines: ReadonlyMap<string, ArtifactBaseline> | undefined,
): AssertionResult {
  const baseline = baselines?.get(assertion.id);
  if (baseline === undefined) {
    return {
      ...failed(
        assertion,
        `No baseline was captured for artifact "${assertion.path}".`,
      ),
      evidence: unchangedEvidence(assertion.path, undefined, undefined),
    };
  }

  if (baseline.kind === 'invalid') {
    return {
      ...failed(assertion, baseline.message),
      evidence: unchangedEvidence(assertion.path, baseline, undefined),
    };
  }

  if (baseline.kind === 'missing') {
    return {
      ...failed(
        assertion,
        `Expected artifact "${assertion.path}" to exist as a regular file before the harness started.`,
      ),
      evidence: unchangedEvidence(assertion.path, baseline, {
        kind: 'missing',
        path: baseline.path,
      }),
    };
  }

  if (baseline.kind === 'not-file') {
    return {
      ...failed(
        assertion,
        `Expected artifact "${assertion.path}" to be a regular file before the harness started, but found ${baseline.fileType}.`,
      ),
      evidence: unchangedEvidence(assertion.path, baseline, undefined),
    };
  }

  if (baseline.kind === 'unreadable') {
    return {
      ...failed(
        assertion,
        `Could not read artifact "${assertion.path}" before the harness started: ${baseline.message}`,
      ),
      evidence: unchangedEvidence(assertion.path, baseline, undefined),
    };
  }

  const resolved = resolveArtifactPath(assertion.path, workDir);
  if (resolved.error !== undefined) {
    return {
      ...failed(assertion, resolved.error),
      evidence: unchangedEvidence(assertion.path, baseline, {
        kind: 'invalid',
        message: resolved.error,
      }),
    };
  }

  try {
    const stats = lstatSync(resolved.path);
    const finalState = finalStateFromStats(resolved.path, stats);
    if (finalState.kind !== 'file') {
      return {
        ...failed(
          assertion,
          `Expected artifact "${assertion.path}" to remain a regular file, but final path is ${describeFinalKind(finalState)}.`,
        ),
        evidence: unchangedEvidence(assertion.path, baseline, finalState),
      };
    }

    const finalBytes = new Uint8Array(readFileSync(resolved.path));
    const finalWithSize = {
      kind: 'file' as const,
      path: resolved.path,
      size: finalBytes.byteLength,
    };

    if (bytesEqual(baseline.bytes, finalBytes)) {
      return passed(
        assertion,
        `Artifact "${assertion.path}" is unchanged (${finalBytes.byteLength} bytes).`,
        unchangedEvidence(assertion.path, baseline, finalWithSize),
      );
    }

    return {
      ...failed(
        assertion,
        `Expected artifact "${assertion.path}" to be unchanged, but contents differ (baseline ${baseline.size} bytes, final ${finalBytes.byteLength} bytes).`,
      ),
      evidence: unchangedEvidence(assertion.path, baseline, finalWithSize),
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        ...failed(
          assertion,
          `Expected artifact "${assertion.path}" to be unchanged, but it was deleted.`,
        ),
        evidence: unchangedEvidence(assertion.path, baseline, {
          kind: 'missing',
          path: resolved.path,
        }),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...failed(
        assertion,
        `Could not read artifact "${assertion.path}" after the harness: ${message}`,
      ),
      evidence: unchangedEvidence(assertion.path, baseline, {
        kind: 'unreadable',
        path: resolved.path,
        message,
      }),
    };
  }
}

function finalStateFromStats(path: string, stats: Stats): ArtifactPathState {
  if (stats.isSymbolicLink()) {
    return {kind: 'not-file', path, fileType: 'symlink'};
  }
  if (stats.isDirectory()) {
    return {kind: 'not-file', path, fileType: 'directory'};
  }
  if (!stats.isFile()) {
    return {kind: 'not-file', path, fileType: 'other'};
  }
  return {kind: 'file', path, size: stats.size};
}

function describeFinalKind(final: ArtifactPathState): string {
  if (final.kind === 'missing') return 'missing';
  if (final.kind === 'not-file') return final.fileType;
  if (final.kind === 'unreadable') return 'unreadable';
  if (final.kind === 'invalid') return 'invalid';
  return 'a regular file';
}

function unchangedEvidence(
  authoredPath: string,
  baseline: ArtifactBaseline | undefined,
  final: ArtifactPathState | undefined,
): ArtifactUnchangedEvidence {
  const evidence: ArtifactUnchangedEvidence = {
    kind: 'unchanged',
    path: authoredPath,
  };
  if (baseline !== undefined) {
    evidence.baseline = baselineSummary(baseline);
  }
  if (final !== undefined) {
    evidence.final = final;
  }
  return evidence;
}

function baselineSummary(baseline: ArtifactBaseline): ArtifactPathState {
  if (baseline.kind === 'file') {
    return {kind: 'file', path: baseline.path, size: baseline.size};
  }
  if (baseline.kind === 'missing') {
    return {kind: 'missing', path: baseline.path};
  }
  if (baseline.kind === 'not-file') {
    return {
      kind: 'not-file',
      path: baseline.path,
      fileType: baseline.fileType,
    };
  }
  if (baseline.kind === 'unreadable') {
    return {
      kind: 'unreadable',
      path: baseline.path,
      message: baseline.message,
    };
  }
  return {kind: 'invalid', message: baseline.message};
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function failedWithEvidence(
  assertion: Pick<IrAssertion, 'id' | 'type'>,
  message: string,
  evidence: ArtifactInspection,
): AssertionResult {
  return {...failed(assertion, message), evidence};
}
