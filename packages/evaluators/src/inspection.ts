import {lstatSync, readFileSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';

export type ArtifactInspection =
  | {kind: 'exists'; path: string; contents?: string}
  | {kind: 'missing'; path: string}
  | {kind: 'invalid'; message: string};

/**
 * Inspect a workdir-relative path using lstat presence semantics so dangling
 * symlinks count as present (aligned with artifact.exists / artifact.notExists).
 */
export function inspectArtifact(
  artifactPath: string,
  workDir: string | undefined,
): ArtifactInspection {
  if (workDir === undefined) {
    return {kind: 'invalid', message: 'work directory unavailable'};
  }
  if (isAbsolute(artifactPath)) {
    return {
      kind: 'invalid',
      message: `artifact path "${artifactPath}" is absolute`,
    };
  }

  const workDirPath = resolve(workDir);
  const resolvedPath = resolve(workDirPath, artifactPath);
  const relativePath = relative(workDirPath, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return {
      kind: 'invalid',
      message: `artifact path "${artifactPath}" is outside the work directory`,
    };
  }

  const presence = pathPresence(resolvedPath);
  if (presence.kind === 'error') {
    return {kind: 'invalid', message: presence.message};
  }
  if (presence.kind === 'missing') {
    return {kind: 'missing', path: resolvedPath};
  }

  try {
    return {
      kind: 'exists',
      path: resolvedPath,
      contents: readFileSync(resolvedPath, 'utf8'),
    };
  } catch {
    return {kind: 'exists', path: resolvedPath};
  }
}

/**
 * lstat-based path presence: dangling symlinks count as present.
 * ENOENT and ENOTDIR both mean the path cannot exist (ENOTDIR covers
 * intermediate components that are regular files, e.g. `file/child`).
 */
export function pathPresence(
  absolutePath: string,
): {kind: 'exists'} | {kind: 'missing'} | {kind: 'error'; message: string} {
  try {
    lstatSync(absolutePath);
    return {kind: 'exists'};
  } catch (error) {
    if (isAbsentPathError(error)) {
      return {kind: 'missing'};
    }
    const message = error instanceof Error ? error.message : String(error);
    return {kind: 'error', message};
  }
}

function isAbsentPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export function resolveArtifactPath(
  artifactPath: string,
  workDir: string | undefined,
): {path: string; error?: never} | {error: string; path?: never} {
  if (workDir === undefined) {
    return {error: 'Artifact assertions require a work directory.'};
  }

  if (isAbsolute(artifactPath)) {
    return {error: `Artifact path "${artifactPath}" must be relative.`};
  }

  const workDirPath = resolve(workDir);
  const resolvedPath = resolve(workDirPath, artifactPath);
  const relativePath = relative(workDirPath, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return {
      error: `Artifact path "${artifactPath}" must stay within the work directory.`,
    };
  }

  return {path: resolvedPath};
}

export function pathStringsFromToolInput(value: unknown): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  const pathKeys = new Set(['path', 'file_path', 'filepath', 'file']);

  function visit(current: unknown): void {
    if (typeof current === 'string') {
      paths.push(current);
      return;
    }

    if (typeof current !== 'object' || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    for (const [key, nested] of Object.entries(current)) {
      if (pathKeys.has(key.toLowerCase()) && typeof nested === 'string') {
        paths.push(nested);
        continue;
      }
      if (Array.isArray(nested)) visit(nested);
    }
  }

  visit(value);
  return paths;
}

export function stringsFromUnknown(value: unknown): string[] {
  const strings: string[] = [];
  const seen = new WeakSet<object>();

  function visit(current: unknown): void {
    if (typeof current === 'string') {
      strings.push(current);
      return;
    }

    if (typeof current !== 'object' || current === null) return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }

    for (const entry of Object.values(current)) visit(entry);
  }

  visit(value);
  return strings;
}

export function extractSkillFiles(value: string): string[] {
  const normalized = value.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const files: string[] = [];

  for (const marker of ['.agents/skills/', '.claude/skills/']) {
    let markerIndex = lower.indexOf(marker);
    while (markerIndex !== -1) {
      const start = skillPathStart(normalized, markerIndex);
      const end = skillPathEnd(normalized, markerIndex + marker.length);
      const candidate = normalized.slice(start, end);
      if (
        /(^|\/)\.(agents|claude)\/skills\/[^/]+\/skill\.md$/i.test(candidate)
      ) {
        files.push(candidate);
      }
      markerIndex = lower.indexOf(marker, markerIndex + marker.length);
    }
  }

  return files;
}

function skillPathStart(value: string, markerIndex: number): number {
  let start = markerIndex;
  while (start > 0 && !isSkillPathBoundary(value[start - 1]!)) start -= 1;
  return start;
}

function skillPathEnd(value: string, startAt: number): number {
  let end = startAt;
  while (end < value.length && !isSkillPathBoundary(value[end]!)) end += 1;
  return end;
}

function isSkillPathBoundary(value: string): boolean {
  return /[\s"'`<>{}[\]();|&]/.test(value);
}
