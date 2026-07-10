import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  captureArtifactBaseline,
  evaluateArtifactNotExists,
  evaluateArtifactUnchanged,
} from './artifactAssertions.js';

function createWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'dynobox-artifact-assertion-'));
}

describe('evaluateArtifactNotExists', () => {
  it('passes when the path is truly absent', () => {
    const workDir = createWorkDir();
    const result = evaluateArtifactNotExists(
      {id: 'assertion.test.0', type: 'artifact.notExists', path: 'gone.txt'},
      workDir,
    );

    expect(result).toMatchObject({
      passed: true,
      message: 'Artifact "gone.txt" is absent.',
      evidence: {kind: 'missing', path: join(workDir, 'gone.txt')},
    });
  });

  it('fails for existing files and directories', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'file.txt'), 'x');
    mkdirSync(join(workDir, 'dir'));

    const file = evaluateArtifactNotExists(
      {id: 'assertion.test.0', type: 'artifact.notExists', path: 'file.txt'},
      workDir,
    );
    const directory = evaluateArtifactNotExists(
      {id: 'assertion.test.1', type: 'artifact.notExists', path: 'dir'},
      workDir,
    );

    expect(file.passed).toBe(false);
    expect(file.evidence).toEqual({
      kind: 'exists',
      path: join(workDir, 'file.txt'),
    });
    expect(directory.passed).toBe(false);
    expect(directory.evidence).toEqual({
      kind: 'exists',
      path: join(workDir, 'dir'),
    });
  });

  it('fails for valid and dangling symlinks using lstat semantics', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'target.txt'), 'ok');
    symlinkSync(join(workDir, 'target.txt'), join(workDir, 'valid-link'));
    symlinkSync(join(workDir, 'missing-target'), join(workDir, 'dangling'));

    const valid = evaluateArtifactNotExists(
      {
        id: 'assertion.test.0',
        type: 'artifact.notExists',
        path: 'valid-link',
      },
      workDir,
    );
    const dangling = evaluateArtifactNotExists(
      {id: 'assertion.test.1', type: 'artifact.notExists', path: 'dangling'},
      workDir,
    );

    expect(valid.passed).toBe(false);
    expect(valid.evidence).toEqual({
      kind: 'exists',
      path: join(workDir, 'valid-link'),
    });
    expect(dangling.passed).toBe(false);
    expect(dangling.evidence).toEqual({
      kind: 'exists',
      path: join(workDir, 'dangling'),
    });
  });

  it('fails for invalid paths and includes resolved diagnostics', () => {
    const workDir = createWorkDir();
    const traversal = evaluateArtifactNotExists(
      {
        id: 'assertion.test.0',
        type: 'artifact.notExists',
        path: '../outside.txt',
      },
      workDir,
    );
    const absolute = evaluateArtifactNotExists(
      {
        id: 'assertion.test.1',
        type: 'artifact.notExists',
        path: join(workDir, 'x'),
      },
      workDir,
    );

    expect(traversal.passed).toBe(false);
    expect(traversal.message).toContain('must stay within the work directory');
    expect(absolute.passed).toBe(false);
    expect(absolute.message).toContain('must be relative');
  });
});

describe('artifact.unchanged baselines and evaluation', () => {
  it('passes when final bytes match the baseline, including binary data', () => {
    const workDir = createWorkDir();
    const binary = Buffer.from([0, 1, 2, 255, 10, 13]);
    writeFileSync(join(workDir, 'blob.bin'), binary);

    const baseline = captureArtifactBaseline('blob.bin', workDir);
    expect(baseline.kind).toBe('file');

    const result = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'blob.bin'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );

    expect(result.passed).toBe(true);
    expect(result.evidence).toMatchObject({
      kind: 'unchanged',
      path: 'blob.bin',
      baseline: {kind: 'file', size: 6},
      final: {kind: 'file', size: 6},
    });
    expect(JSON.stringify(result.evidence)).not.toContain('\\u0000');
  });

  it('passes byte-identical replacements of the same content', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'note.txt'), 'same');
    const baseline = captureArtifactBaseline('note.txt', workDir);
    writeFileSync(join(workDir, 'note.txt'), 'same');

    const result = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'note.txt'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );

    expect(result.passed).toBe(true);
  });

  it('fails same-size and different-size modifications', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'note.txt'), 'abcd');
    const baseline = captureArtifactBaseline('note.txt', workDir);

    writeFileSync(join(workDir, 'note.txt'), 'abce');
    const sameSize = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'note.txt'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );

    writeFileSync(join(workDir, 'note.txt'), 'abcde');
    const differentSize = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'note.txt'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );

    expect(sameSize.passed).toBe(false);
    expect(sameSize.message).toContain('baseline 4 bytes, final 4 bytes');
    expect(differentSize.passed).toBe(false);
    expect(differentSize.message).toContain('baseline 4 bytes, final 5 bytes');
  });

  it('fails when the file is deleted or becomes a non-file', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'note.txt'), 'data');
    const baseline = captureArtifactBaseline('note.txt', workDir);

    unlinkSync(join(workDir, 'note.txt'));
    const deleted = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'note.txt'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );

    mkdirSync(join(workDir, 'note.txt'));
    const typeChanged = evaluateArtifactUnchanged(
      {id: 'assertion.test.0', type: 'artifact.unchanged', path: 'note.txt'},
      workDir,
      new Map([['assertion.test.0', baseline]]),
    );
    rmSync(join(workDir, 'note.txt'), {recursive: true});

    expect(deleted.passed).toBe(false);
    expect(deleted.message).toContain('deleted');
    expect(typeChanged.passed).toBe(false);
    expect(typeChanged.message).toContain('directory');
  });

  it('treats initially missing and non-file paths as assertion failures', () => {
    const workDir = createWorkDir();
    mkdirSync(join(workDir, 'dir'));

    const missingBaseline = captureArtifactBaseline('missing.txt', workDir);
    const directoryBaseline = captureArtifactBaseline('dir', workDir);

    const missing = evaluateArtifactUnchanged(
      {
        id: 'assertion.test.0',
        type: 'artifact.unchanged',
        path: 'missing.txt',
      },
      workDir,
      new Map([['assertion.test.0', missingBaseline]]),
    );
    const directory = evaluateArtifactUnchanged(
      {id: 'assertion.test.1', type: 'artifact.unchanged', path: 'dir'},
      workDir,
      new Map([['assertion.test.1', directoryBaseline]]),
    );

    expect(missingBaseline.kind).toBe('missing');
    expect(directoryBaseline.kind).toBe('not-file');
    expect(missing.passed).toBe(false);
    expect(missing.message).toContain('before the harness started');
    expect(directory.passed).toBe(false);
    expect(directory.message).toContain('directory');
  });
});
