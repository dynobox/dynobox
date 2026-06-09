import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {RunUploadV1} from '@dynobox/run-schema';
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
});
