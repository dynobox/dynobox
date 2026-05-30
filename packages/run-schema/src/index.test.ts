import {describe, expect, it} from 'vitest';

import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  type RunUploadCreateInputV1,
  RunUploadV1,
} from './index.js';

function validPayload(): RunUploadCreateInputV1 {
  return {
    schemaVersion: RUN_UPLOAD_SCHEMA_VERSION,
    createdAt: '2026-05-30T00:00:00.000Z',
    cliVersion: '0.3.0',
    gitHash: 'abc123',
    target: 'packages/cli',
    status: 'failed',
    totals: {
      jobs: 1,
      passed: 0,
      failed: 1,
      warnings: 1,
      durationMs: 1234,
    },
    jobs: [
      {
        jobId: 'scenario.login.claude.iteration.0',
        scenario: {
          id: 'scenario.login',
          name: 'Login flow',
        },
        harness: {
          id: 'claude-code',
          model: 'sonnet',
        },
        iteration: 1,
        status: 'assertion_failed',
        passed: false,
        durationMs: 1234,
        assertions: [
          {
            assertionId: 'assertion.login.0',
            label: 'Shows login form',
            kind: 'finalMessage.includes',
            passed: false,
            message: 'Expected final message to include "login".',
          },
        ],
        diagnostics: ['Final message did not match.'],
        warnings: ['Permission denied for one tool call.'],
      },
    ],
  };
}

describe('RunUploadV1', () => {
  it('accepts a compact valid run upload payload', () => {
    const parsed = RunUploadV1.parse(validPayload());

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.jobs[0]?.assertions[0]?.label).toBe('Shows login form');
  });

  it('rejects unknown fields at every payload level', () => {
    const payload = validPayload();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        transcript: [{role: 'assistant', content: 'secret'}],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [{...payload.jobs[0]!, workDir: '/tmp/dynobox-secret'}],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [
          {
            ...payload.jobs[0]!,
            assertions: [
              {
                ...payload.jobs[0]!.assertions[0]!,
                evidence: {raw: 'tool input'},
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects oversized payload shapes', () => {
    const payload = validPayload();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: Array.from(
          {length: RUN_UPLOAD_LIMITS.jobs + 1},
          () => payload.jobs[0]!,
        ),
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [
          {
            ...payload.jobs[0]!,
            assertions: Array.from(
              {length: RUN_UPLOAD_LIMITS.assertionsPerJob + 1},
              () => payload.jobs[0]!.assertions[0]!,
            ),
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [
          {
            ...payload.jobs[0]!,
            assertions: [
              {
                ...payload.jobs[0]!.assertions[0]!,
                message: 'x'.repeat(
                  RUN_UPLOAD_LIMITS.assertionMessageLength + 1,
                ),
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('requires display fields for runs, jobs, and assertions', () => {
    const payload = validPayload();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        totals: {...payload.totals, durationMs: undefined},
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [
          {
            ...payload.jobs[0]!,
            scenario: {...payload.jobs[0]!.scenario, name: undefined},
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV1.parse({
        ...payload,
        jobs: [
          {
            ...payload.jobs[0]!,
            assertions: [
              {...payload.jobs[0]!.assertions[0]!, label: undefined},
            ],
          },
        ],
      }),
    ).toThrow();
  });
});
