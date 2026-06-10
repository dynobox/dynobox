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
      jobs: [job],
      results: [result],
      target: '.agents/skills/commit',
      gitHash: null,
    });

    expect(RunUploadV1.safeParse(payload).success).toBe(true);
    expect(payload.totals.durationMs).toBe(2);
    expect(payload.jobs[0]?.durationMs).toBe(2);
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
      jobs: [job],
      results: [result],
      target: '.agents/skills/commit',
      gitHash: null,
    });
    const parsed = RunUploadV1.parse(payload);
    const assertion = parsed.jobs[0]!.assertions[0]!;

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
      jobs: [job],
      results: [result],
      target: '.agents/skills/deploy',
      gitHash: null,
    });

    expect(RunUploadV1.safeParse(payload).success).toBe(true);
    const diagnostics = payload.jobs[0]!.diagnostics;
    expect(diagnostics[0]).toBe(
      'setup command `pnpm install` exited with code 1',
    );
    expect(diagnostics[1]).toBe(longDiagnostic.slice(0, 2_000));
    expect(diagnostics).toHaveLength(20);
    expect(diagnostics.every((entry) => entry.trim().length > 0)).toBe(true);
  });
});
