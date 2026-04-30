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
): AssertionResult {
  return evaluateAssertions({assertions: [assertion], toolEvents})[0]!;
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
        kind: 'artifact.exists',
        path: 'result.txt',
      } as unknown as IrAssertion,
      [],
    );

    expect(result).toEqual({
      assertionId: 'assertion.test.0',
      kind: 'artifact.exists',
      passed: false,
      message:
        'Assertion kind "artifact.exists" is not supported by this evaluator.',
    });
  });
});
