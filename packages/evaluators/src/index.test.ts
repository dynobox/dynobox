import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {IrAssertion} from '@dynobox/sdk';
import {describe, expect, it} from 'vitest';

import {
  type AssertionResult,
  evaluateAssertions,
  type ToolEvent,
} from './index.js';

const shellEvent: ToolEvent = {
  kind: 'shell',
  rawName: 'Bash',
  input: {command: 'pnpm test -- --runInBand'},
  command: 'pnpm test -- --runInBand',
};

function toolAssertion(
  assertion: Omit<Extract<IrAssertion, {kind: 'tool.called'}>, 'id'>,
): IrAssertion {
  return {
    id: 'assertion.test.0',
    ...assertion,
  };
}

function evaluateOne(
  assertion: IrAssertion,
  toolEvents: readonly ToolEvent[],
  options?: Omit<
    Parameters<typeof evaluateAssertions>[0],
    'assertions' | 'toolEvents'
  >,
): AssertionResult {
  return evaluateAssertions({
    assertions: [assertion],
    toolEvents,
    ...options,
  })[0]!;
}

function createWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'dynobox-evaluator-test-'));
}

describe('evaluateAssertions', () => {
  it('passes when a kind-only shell assertion observes a shell event', () => {
    const result = evaluateOne(
      toolAssertion({kind: 'tool.called', toolKind: 'shell'}),
      [shellEvent],
    );

    expect(result).toMatchObject({
      assertionId: 'assertion.test.0',
      kind: 'tool.called',
      passed: true,
      message: 'Observed tool "shell".',
    });
    expect(result.evidence).toEqual(shellEvent);
  });

  it('fails when a kind-only shell assertion observes no shell event', () => {
    const result = evaluateOne(
      toolAssertion({kind: 'tool.called', toolKind: 'shell'}),
      [],
    );

    expect(result).toMatchObject({
      passed: false,
      message: 'Expected tool "shell" to be called, but observed none.',
    });
  });

  it('evaluates includes shell matchers', () => {
    const pass = evaluateOne(
      toolAssertion({
        kind: 'tool.called',
        toolKind: 'shell',
        matcher: {includes: 'pnpm test'},
      }),
      [shellEvent],
    );
    const fail = evaluateOne(
      toolAssertion({
        kind: 'tool.called',
        toolKind: 'shell',
        matcher: {includes: 'pnpm build'},
      }),
      [shellEvent],
    );

    expect(pass.passed).toBe(true);
    expect(pass.message).toBe(
      'Observed shell command matching includes "pnpm test".',
    );
    expect(fail.passed).toBe(false);
    expect(fail.message).toBe(
      'Expected shell command matching includes "pnpm build", but no matching shell command was observed.',
    );
  });

  it('evaluates non-shell kind-only tool assertions', () => {
    const editEvent: ToolEvent = {
      kind: 'edit_file',
      rawName: 'Edit',
      input: {file_path: 'src/index.ts'},
    };

    const pass = evaluateOne(
      toolAssertion({kind: 'tool.called', toolKind: 'edit_file'}),
      [editEvent],
    );
    const fail = evaluateOne(
      toolAssertion({kind: 'tool.called', toolKind: 'web_search'}),
      [editEvent],
    );

    expect(pass).toMatchObject({
      passed: true,
      message: 'Observed tool "edit_file".',
      evidence: editEvent,
    });
    expect(fail).toMatchObject({
      passed: false,
      message: 'Expected tool "web_search" to be called, but observed none.',
    });
  });

  it('evaluates mcp, task, and unknown as kind-only tool assertions', () => {
    const toolEvents: ToolEvent[] = [
      {kind: 'mcp', rawName: 'mcp__github__search', input: {query: 'x'}},
      {kind: 'task', rawName: 'Task', input: {description: 'search'}},
      {kind: 'unknown', rawName: 'UnexpectedTool', input: {value: true}},
    ];

    const results = evaluateAssertions({
      assertions: [
        {id: 'assertion.test.0', kind: 'tool.called', toolKind: 'mcp'},
        {id: 'assertion.test.1', kind: 'tool.called', toolKind: 'task'},
        {id: 'assertion.test.2', kind: 'tool.called', toolKind: 'unknown'},
      ],
      toolEvents,
    });

    expect(results.map((result) => result.passed)).toEqual([true, true, true]);
  });

  it('passes tool.notCalled when no matching event exists', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'tool.notCalled',
        toolKind: 'shell',
        matcher: {includes: 'npm publish'},
      },
      [shellEvent],
    );

    expect(result).toMatchObject({
      passed: true,
      message: 'Observed no shell command matching includes "npm publish".',
    });
  });

  it('fails tool.notCalled when a matching event exists', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'tool.notCalled',
        toolKind: 'shell',
        matcher: {includes: 'pnpm test'},
      },
      [shellEvent],
    );

    expect(result).toMatchObject({
      passed: false,
      message:
        'Expected no shell command matching includes "pnpm test", but observed a matching command.',
      evidence: shellEvent,
    });
  });

  it('passes sequence.inOrder with unrelated events between steps', () => {
    const first: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git status'},
      command: 'git status',
    };
    const unrelated: ToolEvent = {
      kind: 'read_file',
      rawName: 'Read',
      input: {filePath: 'README.md'},
    };
    const second: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git commit -m test'},
      command: 'git commit -m test',
    };

    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git status'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git commit'},
          },
        ],
      },
      [first, unrelated, second],
    );

    expect(result).toMatchObject({
      passed: true,
      message: 'Observed 2 ordered tool steps.',
      evidence: [first, second],
    });
  });

  it('passes sequence.inOrder with ordered steps in one shell command', () => {
    const event: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git add README.md && git commit -m test'},
      command: 'git add README.md && git commit -m test',
    };

    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git add'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git commit'},
          },
        ],
      },
      [event],
    );

    expect(result).toMatchObject({
      passed: true,
      message: 'Observed 2 ordered tool steps.',
      evidence: [event, event],
    });
  });

  it('fails sequence.inOrder when one shell command has steps out of order', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git add'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git commit'},
          },
        ],
      },
      [
        {
          kind: 'shell',
          rawName: 'Bash',
          input: {command: 'git commit -m test && git add README.md'},
          command: 'git commit -m test && git add README.md',
        },
      ],
    );

    expect(result).toMatchObject({
      passed: false,
      message:
        'Expected ordered step #2 (tool.called(shell, includes "git commit")) to match an observed tool event, but none was observed after the previous step.',
    });
  });

  it('continues sequence.inOrder from one shell command into later events', () => {
    const first: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git status && git diff -- README.md'},
      command: 'git status && git diff -- README.md',
    };
    const second: ToolEvent = {
      kind: 'shell',
      rawName: 'Bash',
      input: {command: 'git commit -m test'},
      command: 'git commit -m test',
    };

    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git status'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git diff'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git commit'},
          },
        ],
      },
      [first, second],
    );

    expect(result).toMatchObject({
      passed: true,
      message: 'Observed 3 ordered tool steps.',
      evidence: [first, first, second],
    });
  });

  it('fails sequence.inOrder when events are out of order', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git status'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'git commit'},
          },
        ],
      },
      [
        {
          kind: 'shell',
          rawName: 'Bash',
          input: {command: 'git commit -m test'},
          command: 'git commit -m test',
        },
        {
          kind: 'shell',
          rawName: 'Bash',
          input: {command: 'git status'},
          command: 'git status',
        },
      ],
    );

    expect(result).toMatchObject({
      passed: false,
      message:
        'Expected ordered step #2 (tool.called(shell, includes "git commit")) to match an observed tool event, but none was observed after the previous step.',
    });
  });

  it('does not reuse one shell command span for repeated sequence steps', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'sequence.inOrder',
        steps: [
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'pnpm test'},
          },
          {
            kind: 'tool.called',
            toolKind: 'shell',
            matcher: {includes: 'pnpm test'},
          },
        ],
      },
      [shellEvent],
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain('ordered step #2');
  });

  it('evaluates artifact.exists pass and fail cases', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'CHANGELOG.md'), 'release notes');

    const pass = evaluateOne(
      {id: 'assertion.test.0', kind: 'artifact.exists', path: 'CHANGELOG.md'},
      [],
      {workDir},
    );
    const fail = evaluateOne(
      {id: 'assertion.test.1', kind: 'artifact.exists', path: 'missing.txt'},
      [],
      {workDir},
    );

    expect(pass.passed).toBe(true);
    expect(fail).toMatchObject({
      passed: false,
      message: 'Expected artifact "missing.txt" to exist.',
    });
  });

  it('evaluates artifact.contains pass and fail cases', () => {
    const workDir = createWorkDir();
    writeFileSync(join(workDir, 'CHANGELOG.md'), 'dynobox@0.0.4');

    const pass = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'artifact.contains',
        path: 'CHANGELOG.md',
        text: 'dynobox@0.0.4',
      },
      [],
      {workDir},
    );
    const fail = evaluateOne(
      {
        id: 'assertion.test.1',
        kind: 'artifact.contains',
        path: 'CHANGELOG.md',
        text: 'missing',
      },
      [],
      {workDir},
    );

    expect(pass.passed).toBe(true);
    expect(fail).toMatchObject({
      passed: false,
      message: 'Expected artifact "CHANGELOG.md" to contain "missing".',
    });
  });

  it('rejects artifact path traversal and absolute paths', () => {
    const workDir = createWorkDir();
    const traversal = evaluateOne(
      {id: 'assertion.test.0', kind: 'artifact.exists', path: '../outside.txt'},
      [],
      {workDir},
    );
    const absolute = evaluateOne(
      {
        id: 'assertion.test.1',
        kind: 'artifact.exists',
        path: join(workDir, 'x'),
      },
      [],
      {workDir},
    );

    expect(traversal.message).toBe(
      'Artifact path "../outside.txt" must stay within the work directory.',
    );
    expect(absolute.message).toContain('must be relative');
  });

  it('evaluates transcript.contains pass and fail cases', () => {
    const pass = evaluateOne(
      {id: 'assertion.test.0', kind: 'transcript.contains', text: 'EOTP'},
      [],
      {transcript: 'hello EOTP'},
    );
    const fail = evaluateOne(
      {id: 'assertion.test.1', kind: 'transcript.contains', text: 'missing'},
      [],
      {transcript: 'hello'},
    );

    expect(pass.passed).toBe(true);
    expect(fail).toMatchObject({
      passed: false,
      message: 'Expected transcript to contain "missing".',
    });
  });

  it('evaluates finalMessage.contains pass and fail cases', () => {
    const pass = evaluateOne(
      {id: 'assertion.test.0', kind: 'finalMessage.contains', text: 'dirty'},
      [],
      {finalMessage: 'working tree is dirty'},
    );
    const fail = evaluateOne(
      {id: 'assertion.test.1', kind: 'finalMessage.contains', text: 'dirty'},
      [],
      {},
    );

    expect(pass.passed).toBe(true);
    expect(fail).toMatchObject({
      passed: false,
      message:
        'Expected final message to contain "dirty", but final message text is unavailable.',
    });
  });

  it('returns a clear unsupported result for HTTP assertions', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'http.called',
        endpointId: 'endpoint.test.getUser',
      },
      [],
    );

    expect(result).toEqual({
      assertionId: 'assertion.test.0',
      kind: 'http.called',
      passed: false,
      message:
        'Assertion kind "http.called" is not supported by this evaluator.',
    });
  });

  it('returns a clear unsupported result for unknown assertion kinds', () => {
    const result = evaluateOne(
      {
        id: 'assertion.test.0',
        kind: 'custom.assertion',
      } as unknown as IrAssertion,
      [],
    );

    expect(result).toEqual({
      assertionId: 'assertion.test.0',
      kind: 'custom.assertion',
      passed: false,
      message:
        'Assertion kind "custom.assertion" is not supported by this evaluator.',
    });
  });
});
