import {RunUploadV1} from '@dynobox/run-schema';
import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {buildRunUploadPayload} from './uploadRun.js';

describe('buildRunUploadPayload', () => {
  it('normalizes dynamic runner values to the shared upload schema', () => {
    const job = {
      id: 'scenario.labels.claude-code.iteration.0',
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
            kind: 'tool.called',
            toolKind: 'shell',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'passed',
      passed: true,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          kind: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      diagnostics: [],
      warnings: [],
      timing: {
        setupMs: 0.2,
        harnessMs: 1.2,
        assertionsMs: 0.1,
        totalMs: 1.5,
      },
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: '.agents/skills/commit/commit.dyno.ts',
          name: null,
          target: 'commit',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: '.agents/skills/commit',
      gitHash: null,
    });

    expect(RunUploadV1.safeParse(payload).success).toBe(true);
    expect(payload.totals.durationMs).toBe(2);
    expect(payload.dynos[0]?.target).toBe('commit');
    expect(payload.dynos[0]?.jobs[0]?.durationMs).toBe(2);
  });

  it('includes nested sequence assertion display details', () => {
    const job = {
      id: 'scenario.commit.claude-code.iteration.0',
      scenario: {
        id: 'scenario.commit',
        name: 'commit workflow',
        prompt: 'commit safely',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.commit.sequence',
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
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'assertion_failed',
      passed: false,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.commit.sequence',
          kind: 'sequence.inOrder',
          passed: false,
          message:
            'Expected ordered step #3 (tool.called(shell, includes: git commit)) to match an observed tool event, but none was observed after the previous step.',
          evidence: [
            {kind: 'shell', rawName: 'Bash', input: {}, command: 'git status'},
            {kind: 'shell', rawName: 'Bash', input: {}, command: 'git diff'},
          ],
        },
      ],
      diagnostics: [],
      warnings: [],
      harnessResult: {
        finalMessage: '',
        success: true,
        toolEvents: [
          {kind: 'shell', rawName: 'Bash', input: {}, command: 'git status'},
          {kind: 'shell', rawName: 'Bash', input: {}, command: 'git diff'},
        ],
        transcript: '',
      },
      timing: {setupMs: 0, harnessMs: 10, assertionsMs: 1, totalMs: 11},
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: '.agents/skills/commit/commit.dyno.ts',
          name: null,
          target: 'commit',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: '.agents/skills/commit',
      gitHash: null,
    });
    const parsed = RunUploadV1.parse(payload);
    const assertion = parsed.dynos[0]!.jobs[0]!.assertions[0]!;

    expect(assertion.definition?.steps).toHaveLength(3);
    expect(assertion.display?.observed).toBe('matched 2 of 3 ordered steps');
    expect(assertion.display?.children.map((child) => child.passed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(assertion.evidence).toMatchObject({
      matchedCount: 2,
      observedCount: 2,
      observedKinds: ['shell'],
    });
  });

  it('includes anyOf branch definitions and results in the upload payload', () => {
    const job = {
      id: 'scenario.flexible.claude-code.iteration.0',
      scenario: {
        id: 'scenario.flexible',
        name: 'flexible workflow',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.flexible.anyof',
            kind: 'anyOf',
            steps: [
              {kind: 'artifact.exists', path: 'report.json'},
              {kind: 'http.called', endpointId: 'endpoint.upload'},
              {kind: 'transcript.contains', text: 'uploaded'},
              {kind: 'skill.referenced', skill: 'release'},
            ],
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'passed',
      passed: true,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.flexible.anyof',
          kind: 'anyOf',
          passed: true,
          message: 'Matched anyOf branch #2: Observed HTTP request.',
          evidence: {
            kind: 'anyOf',
            branchIndex: 2,
            branches: [
              {
                assertionId: 'assertion.flexible.anyof.branch.1',
                kind: 'artifact.exists',
                passed: false,
                message: 'Artifact "report.json" was not found.',
              },
              {
                assertionId: 'assertion.flexible.anyof.branch.2',
                kind: 'http.called',
                passed: true,
                message: 'Observed HTTP request.',
              },
              {
                assertionId: 'assertion.flexible.anyof.branch.3',
                kind: 'transcript.contains',
                passed: false,
                message: 'Transcript did not include "uploaded".',
              },
              {
                assertionId: 'assertion.flexible.anyof.branch.4',
                kind: 'skill.referenced',
                passed: true,
                message: 'Observed skill reference.',
              },
            ],
          },
        },
      ],
      diagnostics: [],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 10, assertionsMs: 1, totalMs: 11},
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: 'flexible.dyno.ts',
          name: null,
          target: 'flexible',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: 'flexible.dyno.ts',
      gitHash: null,
    });
    const assertion =
      RunUploadV1.parse(payload).dynos[0]!.jobs[0]!.assertions[0]!;

    expect(assertion.definition?.steps?.map((step) => step.kind)).toEqual([
      'artifact.exists',
      'http.called',
      'transcript.contains',
      'skill.referenced',
    ]);
    expect(assertion.display?.children).toMatchObject([
      {passed: false, observed: 'Artifact "report.json" was not found.'},
      {passed: true, observed: 'Observed HTTP request.'},
      {passed: false, observed: 'Transcript did not include "uploaded".'},
      {passed: true, observed: 'Observed skill reference.'},
    ]);
  });

  it('does not count failed command.called observed evidence as matches', () => {
    const job = {
      id: 'scenario.command.claude-code.iteration.0',
      scenario: {
        id: 'scenario.command',
        name: 'command workflow',
        prompt: 'commit safely',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.command.called',
            kind: 'command.called',
            executable: 'git',
            matcher: {args: ['commit']},
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'assertion_failed',
      passed: false,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.command.called',
          kind: 'command.called',
          passed: false,
          message:
            'Expected command:\n  git with args ["commit"]\nObserved commands:\n  1. git status\n  2. git add README.md\nNo observed git command included arg "commit".',
          evidence: [
            {executable: 'git', argv: ['status']},
            {executable: 'git', argv: ['add', 'README.md']},
          ],
        },
      ],
      diagnostics: [],
      warnings: [],
      harnessResult: {
        finalMessage: '',
        success: true,
        toolEvents: [
          {
            kind: 'shell',
            rawName: 'Bash',
            input: {},
            command: 'git status && git add README.md',
          },
        ],
        transcript: '',
      },
      timing: {setupMs: 0, harnessMs: 10, assertionsMs: 1, totalMs: 11},
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: '.agents/skills/commit/commit.dyno.ts',
          name: null,
          target: 'commit',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: '.agents/skills/commit',
      gitHash: null,
    });
    const assertion =
      RunUploadV1.parse(payload).dynos[0]!.jobs[0]!.assertions[0]!;

    expect(assertion.display?.observed).toBe(
      '1. git status 2. git add README.md',
    );
    expect(assertion.evidence).toMatchObject({
      observedCount: 1,
      observedKinds: ['shell'],
    });
    expect(assertion.evidence).not.toHaveProperty('matchedCount');
    expect(assertion.evidence).not.toHaveProperty('matches');
  });

  it('preserves empty verify output matchers in upload payloads', () => {
    const job = {
      id: 'scenario.verify.claude-code.iteration.0',
      scenario: {
        id: 'scenario.verify',
        name: 'verify workflow',
        prompt: 'check stderr',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.verify.empty-stderr',
            kind: 'verify.command',
            command: 'pnpm test',
            exitCode: 0,
            stdout: {equals: ''},
            stderr: {equals: ''},
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'passed',
      passed: true,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [
        {
          assertionId: 'assertion.verify.empty-stderr',
          kind: 'verify.command',
          passed: true,
          message: 'Verify command passed.',
          evidence: {
            command: 'pnpm test',
            exitCode: 0,
            stdout: '',
            stderr: '',
          },
        },
      ],
      diagnostics: [],
      warnings: [],
      harnessResult: {
        finalMessage: '',
        success: true,
        toolEvents: [],
        transcript: '',
      },
      timing: {setupMs: 0, harnessMs: 10, assertionsMs: 1, totalMs: 11},
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: '.agents/skills/verify/verify.dyno.ts',
          name: null,
          target: 'verify',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: '.agents/skills/verify',
      gitHash: null,
    });
    const assertion =
      RunUploadV1.parse(payload).dynos[0]!.jobs[0]!.assertions[0]!;

    expect(assertion.definition).toMatchObject({
      stdout: {equals: ''},
      stderr: {equals: ''},
    });
  });

  it('preserves runner diagnostics, capped and truncated, for failing runs', () => {
    const job = {
      id: 'scenario.deploy.claude-code.iteration.0',
      scenario: {
        id: 'scenario.deploy',
        name: 'deploy',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const longDiagnostic = 'x'.repeat(2_500);
    const result = {
      jobId: job.id,
      scenarioId: job.scenario.id,
      harness: 'claude-code',
      iteration: 0,
      status: 'harness_failed',
      passed: false,
      setupResult: {success: true, logs: []},
      httpEvents: [],
      artifacts: [],
      assertionResults: [],
      diagnostics: [
        '  setup command `pnpm install` exited with code 1  ',
        '',
        '   ',
        longDiagnostic,
        ...Array.from({length: 25}, (_, i) => `diag ${i}`),
      ],
      warnings: [],
      timing: {setupMs: 0, harnessMs: 10, assertionsMs: 0, totalMs: 10},
    } as unknown as LocalRunnerResult;

    const payload = buildRunUploadPayload({
      dynos: [
        {
          dynoPath: '.agents/skills/deploy/deploy.dyno.ts',
          name: null,
          target: 'deploy',
          jobs: [job],
        },
      ],
      results: [result],
      inputPath: '.agents/skills/deploy',
      gitHash: null,
    });

    expect(RunUploadV1.safeParse(payload).success).toBe(true);
    const diagnostics = payload.dynos[0]!.jobs[0]!.diagnostics;
    expect(diagnostics[0]).toBe(
      'setup command `pnpm install` exited with code 1',
    );
    expect(diagnostics[1]).toBe(longDiagnostic.slice(0, 2_000));
    expect(diagnostics).toHaveLength(20);
    expect(diagnostics.every((entry) => entry.trim().length > 0)).toBe(true);
  });
});
