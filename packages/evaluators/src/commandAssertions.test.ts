import {describe, expect, it} from 'vitest';

import {
  evaluateCommandCalledAssertion,
  evaluateCommandNotCalledAssertion,
  extractObservedCommands,
} from './commandAssertions.js';
import type {CliMockCall, ToolEvent} from './types.js';

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

function cliMockCall(
  executable: string,
  argv: string[],
  cwd = '/workdir',
): CliMockCall {
  return {
    executable,
    argv,
    cwd,
    timestamp: 1,
    exitCode: 0,
    stdout: '',
    stderr: '',
  };
}

describe('extractObservedCommands shell grouping', () => {
  it('unwraps subshell wrappers and splits compound commands inside them', () => {
    const command =
      '(npx dynobox validate tmp/failing.dyno.yaml 2>&1; echo "EXIT: $?")';

    expect(
      observedSummary(extractObservedCommands([shellEvent(command)])),
    ).toEqual([
      {
        executable: 'npx',
        argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml', '2'],
      },
      {
        executable: 'echo',
        argv: ['EXIT: $?'],
      },
    ]);
  });

  it('unwraps brace-group wrappers and splits compound commands inside them', () => {
    const command =
      '{ npx dynobox validate tmp/failing.dyno.yaml; echo "EXIT: $?"; }';

    expect(
      observedSummary(extractObservedCommands([shellEvent(command)])),
    ).toEqual([
      {
        executable: 'npx',
        argv: ['dynobox', 'validate', 'tmp/failing.dyno.yaml'],
      },
      {
        executable: 'echo',
        argv: ['EXIT: $?'],
      },
    ]);
  });

  it('unwraps groups that are followed only by redirections', () => {
    expect(
      observedSummary(
        extractObservedCommands([
          shellEvent('{ npx dynobox validate tmp/x; echo "EXIT: $?"; } 2>&1'),
        ]),
      ),
    ).toEqual([
      {
        executable: 'npx',
        argv: ['dynobox', 'validate', 'tmp/x'],
      },
      {
        executable: 'echo',
        argv: ['EXIT: $?'],
      },
    ]);

    expect(
      observedSummary(
        extractObservedCommands([
          shellEvent('(npx dynobox validate; echo done) >out'),
        ]),
      ),
    ).toEqual([
      {
        executable: 'npx',
        argv: ['dynobox', 'validate'],
      },
      {
        executable: 'echo',
        argv: ['done'],
      },
    ]);
  });

  it('keeps outer compound separators while unwrapping grouped segments', () => {
    const command = 'echo start && (git status; git diff) && echo done';

    expect(
      observedSummary(extractObservedCommands([shellEvent(command)])),
    ).toEqual([
      {executable: 'echo', argv: ['start']},
      {executable: 'git', argv: ['status']},
      {executable: 'git', argv: ['diff']},
      {executable: 'echo', argv: ['done']},
    ]);
  });

  it('does not split on separators inside quotes even with grouping markers', () => {
    const command = 'git commit -m "fix: (a; b) {c}"';

    expect(
      observedSummary(extractObservedCommands([shellEvent(command)])),
    ).toEqual([
      {
        executable: 'git',
        argv: ['commit', '-m', 'fix: (a; b) {c}'],
      },
    ]);
  });

  it('does not unwrap a group when non-redirection text follows the closer', () => {
    // Adjacent groups are one segment; do not strip only the first pair.
    expect(
      observedSummary(
        extractObservedCommands([shellEvent('(echo a) (echo b)')]),
      ),
    ).toEqual([]);
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
    expect(result.message).toContain('No normalized npx command was observed.');
    expect(result.message).toContain(
      'Raw shell events included text matching "npx"; command normalization may not support this shell shape.',
    );
    expect(result.message).toContain(`- ${raw}`);
    // Evidence stays ObservedCommand[] for CLI/upload Array.isArray consumers.
    expect(Array.isArray(result.evidence)).toBe(true);
  });
});

describe('CLI mock command observations', () => {
  it('creates exact command observations from call records', () => {
    const observed = extractObservedCommands([], {
      cliMockCalls: [cliMockCall('vitest', ['run', '--ui'])],
      cliMockExecutableNames: ['vitest'],
    });

    expect(observed).toEqual([
      expect.objectContaining({
        toolCallId: 'cli-mock:0',
        executable: 'vitest',
        argv: ['run', '--ui'],
        cwd: '/workdir',
        cliMockCallIndex: 0,
      }),
    ]);
  });

  it('pairs shell commands with records without duplicate observations', () => {
    const observed = extractObservedCommands([shellEvent('vitest run')], {
      cliMockCalls: [cliMockCall('vitest', ['run'], '/actual')],
      cliMockExecutableNames: ['vitest'],
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      executable: 'vitest',
      argv: ['run'],
      cwd: '/actual',
      original: 'vitest run',
      eventIndex: 0,
      cliMockCallIndex: 0,
    });
  });

  it('suppresses unrecorded bare mocks but preserves explicit paths', () => {
    const observed = extractObservedCommands(
      [
        shellEvent(
          'vitest run; /usr/bin/vitest real; ./vitest local; git status',
        ),
      ],
      {cliMockExecutableNames: ['vitest']},
    );

    expect(
      observed.map(({executable, executablePath, argv}) => ({
        executable,
        executablePath,
        argv,
      })),
    ).toEqual([
      {
        executable: 'vitest',
        executablePath: '/usr/bin/vitest',
        argv: ['real'],
      },
      {
        executable: 'vitest',
        executablePath: './vitest',
        argv: ['local'],
      },
      {executable: 'git', executablePath: undefined, argv: ['status']},
    ]);
  });

  it('pairs only exact argv and appends unmatched calls in invocation order', () => {
    const observed = extractObservedCommands(
      [shellEvent('vitest run; vitest watch')],
      {
        cliMockCalls: [
          cliMockCall('vitest', ['watch']),
          cliMockCall('vitest', ['nested']),
        ],
        cliMockExecutableNames: ['vitest'],
      },
    );

    expect(observed.map((command) => command.argv)).toEqual([
      ['watch'],
      ['nested'],
    ]);
    expect(observed.map((command) => command.cliMockCallIndex)).toEqual([0, 1]);
  });

  it('leaves calls unpaired when a shell event contains multiple commands', () => {
    const observed = extractObservedCommands(
      [shellEvent('false && vitest run')],
      {
        cliMockCalls: [cliMockCall('vitest', ['run'])],
        cliMockExecutableNames: ['vitest'],
      },
    );

    expect(observed).toEqual([
      expect.objectContaining({
        executable: 'false',
      }),
      expect.objectContaining({
        executable: 'vitest',
        cliMockCallIndex: 0,
        cliMockEventPaired: false,
      }),
    ]);
  });

  it('uses records for called and notCalled assertions', () => {
    const options = {
      cliMockCalls: [cliMockCall('vitest', ['run'])],
      cliMockExecutableNames: ['vitest'],
    };
    const called = evaluateCommandCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'command.called',
        executable: 'vitest',
        command: {args: ['run']},
      },
      [],
      options,
    );
    const notCalled = evaluateCommandNotCalledAssertion(
      {
        id: 'assertion.test.1',
        type: 'command.notCalled',
        executable: 'vitest',
      },
      [],
      options,
    );

    expect(called.passed).toBe(true);
    expect(notCalled.passed).toBe(false);
  });

  it('does not report a normalization gap for an unrecorded configured mock', () => {
    const result = evaluateCommandCalledAssertion(
      {
        id: 'assertion.test.0',
        type: 'command.called',
        executable: 'vitest',
      },
      [shellEvent('vitest run')],
      {cliMockCalls: [], cliMockExecutableNames: ['vitest']},
    );

    expect(result.passed).toBe(false);
    expect(result.message).not.toContain('normalization may not support');
  });
});
