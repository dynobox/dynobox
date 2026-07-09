import {describe, expect, it} from 'vitest';

import {
  evaluateCommandCalledAssertion,
  extractObservedCommands,
} from './commandAssertions.js';
import type {ToolEvent} from './types.js';

function shellEvent(command: string): ToolEvent {
  return {
    kind: 'shell',
    rawName: 'Bash',
    input: {command},
    command,
  };
}

function observedSummary(
  commands: ReturnType<typeof extractObservedCommands>,
): Array<{executable: string; argv: string[]}> {
  return commands.map((command) => ({
    executable: command.executable,
    argv: command.argv,
  }));
}

describe('extractObservedCommands shell grouping', () => {
  it('unwraps subshell wrappers and splits compound commands inside them', () => {
    const command =
      '(npx dynobox validate tmp/failing.dyno.yaml 2>&1; echo "EXIT: $?")';

    expect(observedSummary(extractObservedCommands([shellEvent(command)]))).toEqual(
      [
        {
          executable: 'npx',
          argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml', '2'],
        },
        {
          executable: 'echo',
          argv: ['EXIT: $?'],
        },
      ],
    );
  });

  it('unwraps brace-group wrappers and splits compound commands inside them', () => {
    const command =
      '{ npx dynobox validate tmp/failing.dyno.yaml; echo "EXIT: $?"; }';

    expect(observedSummary(extractObservedCommands([shellEvent(command)]))).toEqual(
      [
        {
          executable: 'npx',
          argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml'],
        },
        {
          executable: 'echo',
          argv: ['EXIT: $?'],
        },
      ],
    );
  });

  it('keeps outer compound separators while unwrapping grouped segments', () => {
    const command = 'echo start && (git status; git diff) && echo done';

    expect(observedSummary(extractObservedCommands([shellEvent(command)]))).toEqual(
      [
        {executable: 'echo', argv: ['start']},
        {executable: 'git', argv: ['status']},
        {executable: 'git', argv: ['diff']},
        {executable: 'echo', argv: ['done']},
      ],
    );
  });

  it('does not split on separators inside quotes even with grouping markers', () => {
    const command = 'git commit -m "fix: (a; b) {c}"';

    expect(observedSummary(extractObservedCommands([shellEvent(command)]))).toEqual(
      [
        {
          executable: 'git',
          argv: ['commit', '-m', 'fix: (a; b) {c}'],
        },
      ],
    );
  });
});

describe('evaluateCommandCalledAssertion grouping and diagnostics', () => {
  it('passes command.called for npx inside a subshell exit-code capture', () => {
    const result = evaluateCommandCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'command.called',
        executable: 'npx',
        command: {args: ['dynobox', 'validate']},
      },
      [
        shellEvent(
          '(npx dynobox validate tmp/failing.dyno.yaml 2>&1; echo "EXIT: $?")',
        ),
      ],
    );

    expect(result).toMatchObject({
      passed: true,
      evidence: {
        executable: 'npx',
        argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml', '2'],
      },
    });
  });

  it('passes command.called for npx inside a brace-group exit-code capture', () => {
    const result = evaluateCommandCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'command.called',
        executable: 'npx',
        command: {args: ['dynobox', 'validate']},
      },
      [
        shellEvent(
          '{ npx dynobox validate tmp/failing.dyno.yaml; echo "EXIT: $?"; }',
        ),
      ],
    );

    expect(result).toMatchObject({
      passed: true,
      evidence: {
        executable: 'npx',
        argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml'],
      },
    });
  });

  it('reports raw shell matches when normalization cannot surface the executable', () => {
    // Command substitution is intentionally not expanded by normalization.
    const raw = 'eval "$(echo npx dynobox validate tmp/failing.dyno.yaml)"';
    const result = evaluateCommandCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'command.called',
        executable: 'npx',
        command: {args: ['dynobox', 'validate']},
      },
      [shellEvent(raw)],
    );

    expect(result.passed).toBe(false);
    expect(result.message).toContain(
      'No normalized npx command was observed.',
    );
    expect(result.message).toContain(
      'Raw shell events included text matching "npx"; command normalization may not support this shell shape.',
    );
    expect(result.message).toContain(`- ${raw}`);
    expect(result.evidence).toMatchObject({
      rawShellMatches: [raw],
    });
  });
});
