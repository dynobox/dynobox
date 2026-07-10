import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {assertionByIdForJobs} from '../jobs.js';
import {createRenderContext} from '../terminal/index.js';
import {renderAssertionDetails} from './assertions.js';

describe('renderAssertionDetails', () => {
  it('shows assertion labels before assertion descriptions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.labels',
        name: 'labels',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.labels.reads-package',
            label: 'reads package.json',
            type: 'tool.called',
            tool: 'shell',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          type: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    expect(
      renderAssertionDetails(
        result,
        assertionByIdForJobs([job]),
        createRenderContext({usePlainSymbols: true}, {verbose: true}),
      ),
    ).toContain('[ ok ] reads package.json  tool.called(shell)');
  });

  it('shows the observed final message excerpt when finalMessage.contains fails', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.final-message',
        name: 'final message',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.final-message.contains',
            type: 'finalMessage.contains',
            text: 'does not invalidate the original matrix failure',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.final-message.contains',
          type: 'finalMessage.contains',
          passed: false,
          message:
            'Expected final message to contain "does not invalidate the original matrix failure".',
        },
      ],
      harnessResult: {
        toolEvents: [],
        finalMessage:
          'Original run preserved. Matrix signal points at the codex failed job.',
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      'expected  final message containing "does not invalidate the original matrix failure"',
    );
    expect(output).toContain(
      'observed  final message: "Original run preserved. Matrix signal points at the codex failed job."',
    );
    expect(output).not.toContain('observed  Expected final message to contain');
  });

  it('shows observed evidence for failed non-text assertions', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dynobox-render-'));
    writeFileSync(join(workDir, 'output.txt'), 'actual artifact contents');

    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.evidence',
        name: 'evidence',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.tool.called',
            type: 'tool.called',
            tool: 'read_file',
            path: 'missing.txt',
          },
          {
            id: 'assertion.tool.not-called',
            type: 'tool.notCalled',
            tool: 'shell',
            command: {includes: 'pnpm test'},
          },
          {
            id: 'assertion.skill.referenced',
            type: 'skill.referenced',
            skill: 'dyno-debug',
          },
          {
            id: 'assertion.http.not-called',
            type: 'http.notCalled',
            endpointId: 'endpoint.test.getUser',
          },
          {
            id: 'assertion.artifact.contains',
            type: 'artifact.contains',
            path: 'output.txt',
            text: 'expected text',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const shellEvent = {
      kind: 'shell',
      rawName: 'shell',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    };
    const readFileEvent = {
      kind: 'read_file',
      rawName: 'read_file',
      input: {path: 'other.txt'},
    };
    const httpEvent = {
      endpointId: 'endpoint.test.getUser',
      method: 'GET',
      url: 'https://api.example.test/users/1',
      host: 'api.example.test',
      timestamp: '2026-05-22T00:00:00.000Z',
      status: 200,
    };
    const result = {
      workDir,
      httpEvents: [httpEvent],
      assertionResults: [
        {
          assertionId: 'assertion.tool.called',
          type: 'tool.called',
          passed: false,
          message:
            'Expected tool "read_file" with path "missing.txt" to be called, but observed none.',
        },
        {
          assertionId: 'assertion.tool.not-called',
          type: 'tool.notCalled',
          passed: false,
          message:
            'Expected no shell command matching includes "pnpm test", but observed a matching command.',
          evidence: shellEvent,
        },
        {
          assertionId: 'assertion.skill.referenced',
          type: 'skill.referenced',
          passed: false,
          message:
            'Expected skill "dyno-debug" to be referenced, but no reference to its SKILL.md was observed.',
        },
        {
          assertionId: 'assertion.http.not-called',
          type: 'http.notCalled',
          passed: false,
          message:
            'Expected HTTP endpoint "endpoint.test.getUser" not to be called, but observed a matching request.',
          evidence: httpEvent,
        },
        {
          assertionId: 'assertion.artifact.contains',
          type: 'artifact.contains',
          passed: false,
          message: 'Expected artifact "output.txt" to contain "expected text".',
        },
      ],
      harnessResult: {
        toolEvents: [readFileEvent, shellEvent],
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      'observed  1 read_file tool call observed, none for path "missing.txt"',
    );
    expect(output).toContain('observed  matching shell command "pnpm test"');
    expect(output).toContain(
      'observed  no matching SKILL.md reference observed',
    );
    expect(output).toContain(
      'observed  matching request: GET https://api.example.test/users/1 -> 200',
    );
    expect(output).toContain('observed  artifact: "actual artifact contents"');
    expect(output).not.toContain('observed  Expected');
  });

  it('renders artifact.notExists and artifact.unchanged failures', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dynobox-render-'));
    const resolved = join(workDir, 'leftover.txt');
    writeFileSync(resolved, 'still here');

    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.artifact-new',
        name: 'artifact new',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.artifact.not-exists',
            type: 'artifact.notExists',
            path: 'leftover.txt',
          },
          {
            id: 'assertion.artifact.unchanged',
            type: 'artifact.unchanged',
            path: 'stable.txt',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      workDir,
      assertionResults: [
        {
          assertionId: 'assertion.artifact.not-exists',
          type: 'artifact.notExists',
          passed: false,
          message: `Expected artifact "leftover.txt" to be absent, but it exists at ${resolved}.`,
          evidence: {kind: 'exists', path: resolved},
        },
        {
          assertionId: 'assertion.artifact.unchanged',
          type: 'artifact.unchanged',
          passed: false,
          message:
            'Expected artifact "stable.txt" to be unchanged, but contents differ (baseline 4 bytes, final 5 bytes).',
          evidence: {
            kind: 'unchanged',
            path: 'stable.txt',
            baseline: {
              kind: 'file',
              path: join(workDir, 'stable.txt'),
              size: 4,
            },
            final: {
              kind: 'file',
              path: join(workDir, 'stable.txt'),
              size: 5,
            },
          },
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain('artifact.notExists(leftover.txt)');
    expect(output).toContain(`artifact still exists at ${resolved}`);
    expect(output).toContain('artifact.unchanged(stable.txt)');
    expect(output).toContain('baseline file');
    expect(output).toContain('4 bytes');
    expect(output).toContain('5 bytes');
  });

  it('renders artifact failures from captured evidence', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dynobox-render-'));
    writeFileSync(join(workDir, 'created.txt'), 'created later');

    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.artifact-evidence',
        name: 'artifact evidence',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.artifact.exists',
            type: 'artifact.exists',
            path: 'created.txt',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      workDir,
      assertionResults: [
        {
          assertionId: 'assertion.artifact.exists',
          type: 'artifact.exists',
          passed: false,
          message: 'Expected artifact "created.txt" to exist.',
          evidence: {kind: 'missing', path: join(workDir, 'created.txt')},
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      `observed  artifact missing at ${join(workDir, 'created.txt')}`,
    );
    expect(output).not.toContain('observed  artifact exists at');
  });

  it('shows compact observed details for failed command.called assertions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.command-called',
        name: 'command called',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.command.called',
            type: 'command.called',
            executable: 'git',
            command: {args: ['commit']},
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.command.called',
          type: 'command.called',
          passed: false,
          message:
            'Expected command:\n  git with args ["commit"]\nObserved commands:\n  1. git status\n  2. git add README.md\nNo observed git command included arg "commit".',
          evidence: [
            {executable: 'git', argv: ['status']},
            {executable: 'git', argv: ['add', 'README.md']},
          ],
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain('expected  command.called(git, args: ["commit"])');
    expect(output).toContain('observed  0/2 observed command segments matched');
    expect(output).not.toContain('observed parsed commands during this run');
    expect(output).not.toContain('observed  Expected command:');
  });

  it('shows parsed command segments for command assertions in verbose mode', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.command-called-verbose',
        name: 'command called verbose',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.command.called',
            type: 'command.called',
            executable: 'git',
            command: {args: ['commit']},
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.command.called',
          type: 'command.called',
          passed: false,
          message:
            'Expected command:\n  git with args ["commit"]\nObserved commands:\n  1. git status\n  2. git add README.md\nNo observed git command included arg "commit".',
          evidence: [
            {executable: 'git', argv: ['status']},
            {executable: 'git', argv: ['add', 'README.md']},
          ],
        },
      ],
      harnessResult: {
        toolEvents: [
          {
            kind: 'shell',
            rawName: 'shell',
            input: {command: 'git status && git add README.md'},
            command: 'git status && git add README.md',
          },
        ],
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {verbose: true}),
    );

    expect(output).toContain('observed  0/2 observed command segments matched');
    expect(output).toContain('observed parsed commands during this run:');
    expect(output).toContain('1. "git status"');
    expect(output).toContain('2. "git add README.md"');
  });

  it('shows compact branch summaries for failed anyOf assertions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.anyof',
        name: 'anyOf',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.anyof.read',
            type: 'anyOf',
            steps: [
              {
                type: 'tool.called',
                tool: 'read_file',
                path: 'package.json',
              },
              {
                type: 'command.called',
                executable: 'cat',
                command: {args: ['package.json']},
              },
            ],
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.anyof.read',
          type: 'anyOf',
          passed: false,
          message:
            'Expected anyOf to match at least one branch, but all 2 branches failed.\nBranch #1: Expected tool "read_file" with path "package.json" to be called, but observed none.\nBranch #2: Expected command:\n  cat with args ["package.json"]\nObserved commands:\n  1. pwd\nNo observed cat command included arg "package.json".',
          evidence: {
            kind: 'anyOf',
            branches: [
              {
                passed: false,
                message:
                  'Expected tool "read_file" with path "package.json" to be called, but observed none.',
              },
              {
                passed: false,
                message:
                  'Expected command:\n  cat with args ["package.json"]\nObserved commands:\n  1. pwd\nNo observed cat command included arg "package.json".',
              },
            ],
          },
        },
      ],
      harnessResult: {
        toolEvents: [
          {
            kind: 'shell',
            rawName: 'Bash',
            input: {command: 'pwd'},
            command: 'pwd',
          },
        ],
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain('observed  0/2 branches matched');
    expect(output).toContain('#1');
    expect(output).toContain('read_file');
    expect(output).toContain('#2');
    expect(output).toContain('cat');
    expect(output).not.toContain('observed  Expected anyOf to match');
  });

  it('includes nested verify command output when every anyOf branch fails', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.anyof-verify',
        name: 'anyOf verify',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.anyof.verify',
            type: 'anyOf',
            steps: [
              {type: 'artifact.exists', path: 'missing.txt'},
              {
                type: 'verify.command',
                command: 'pnpm test',
                exitCode: 0,
              },
            ],
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.anyof.verify',
          type: 'anyOf',
          passed: false,
          message: 'all branches failed',
          evidence: {
            kind: 'anyOf',
            branches: [
              {
                type: 'artifact.exists',
                passed: false,
                message: 'Expected artifact "missing.txt" to exist.',
              },
              {
                type: 'verify.command',
                passed: false,
                message: 'Verification command "pnpm test" failed: exit code 1',
                evidence: {
                  assertionId: 'assertion.anyof.verify.branch.2',
                  command: 'pnpm test',
                  exitCode: 1,
                  stdout: 'FAIL suite',
                  stderr: 'boom',
                  durationMs: 12,
                },
              },
            ],
          },
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain('0/2 branches matched');
    expect(output).toContain('exit 1');
    expect(output).toContain('FAIL suite');
    expect(output).toContain('boom');
  });

  it('shows command evidence for failed sequence.inOrder assertions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.command-sequence',
        name: 'command sequence',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.sequence',
            type: 'sequence.inOrder',
            steps: [
              {
                type: 'command.called',
                executable: 'git',
                command: {args: ['status']},
              },
              {
                type: 'command.called',
                executable: 'git',
                command: {argsInOrder: ['add', 'README.md']},
              },
              {
                type: 'command.called',
                executable: 'git',
                command: {args: ['commit']},
              },
            ],
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.sequence',
          type: 'sequence.inOrder',
          passed: false,
          message:
            'Expected ordered step #3 (command.called(git)) to match an observed tool event, but none was observed after the previous step.',
          evidence: [
            {executable: 'git', argv: ['status']},
            {executable: 'git', argv: ['add', 'README.md']},
          ],
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      'observed  matched 2 of 3 ordered steps; last matched command "git add README.md"',
    );
  });
});
