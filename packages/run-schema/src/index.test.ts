import {describe, expect, it} from 'vitest';

import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  RUN_UPLOAD_V2_SCHEMA_VERSION,
  type RunUploadCreateInputV2,
  type RunUploadCreateInputV3,
  RunUpload,
  RunUploadV2,
  RunUploadV3,
} from './index.js';

function validPayload(): RunUploadCreateInputV2 {
  return {
    schemaVersion: RUN_UPLOAD_V2_SCHEMA_VERSION,
    createdAt: '2026-05-30T00:00:00.000Z',
    cliVersion: '0.3.0',
    gitHash: 'abc123',
    inputPath: 'packages/cli',
    status: 'failed',
    totals: {
      jobs: 1,
      passed: 0,
      failed: 1,
      warnings: 1,
      durationMs: 1234,
    },
    dynos: [
      {
        dynoPath: 'packages/cli/login.dyno.ts',
        name: 'Login flows',
        target: 'login-agent',
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
                type: 'finalMessage.contains',
                passed: false,
                message: 'Expected final message to include "login".',
                definition: {
                  type: 'sequence.inOrder',
                  steps: [
                    {
                      type: 'tool.called',
                      tool: 'shell',
                      command: {includes: 'pnpm test'},
                    },
                  ],
                },
                display: {
                  title: 'commit workflow',
                  expectation: 'shell command including "pnpm test"',
                  observed: 'matched 0 of 1 ordered steps',
                  children: [
                    {
                      index: 1,
                      type: 'tool.called',
                      title: 'tool.called(shell, includes: pnpm test)',
                      expectation: 'shell command including "pnpm test"',
                      observed: null,
                      passed: false,
                    },
                  ],
                },
                evidence: {
                  matchedCount: 0,
                  observedCount: 2,
                  observedKinds: ['shell'],
                  matches: ['Bash: npm test'],
                },
              },
            ],
            diagnostics: ['Final message did not match.'],
            warnings: ['Permission denied for one tool call.'],
          },
        ],
      },
    ],
  };
}

function validV3Payload(): RunUploadCreateInputV3 {
  const payload = validPayload();
  return {
    ...payload,
    schemaVersion: RUN_UPLOAD_SCHEMA_VERSION,
    dynos: payload.dynos.map((dyno) => ({
      ...dyno,
      jobs: dyno.jobs.map((job) => ({
        ...job,
        harness: {...job.harness, version: '2.1.4'},
      })),
    })),
  };
}

type ValidDyno = NonNullable<ReturnType<typeof validPayload>['dynos']>[number];

function validDyno(): ValidDyno {
  return validPayload().dynos[0]!;
}

describe('RunUploadV2', () => {
  it('accepts a compact valid run upload payload', () => {
    const parsed = RunUploadV2.parse(validPayload());

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.inputPath).toBe('packages/cli');
    expect(parsed.dynos[0]?.target).toBe('login-agent');
    expect(parsed.dynos[0]?.jobs[0]?.assertions[0]?.label).toBe(
      'Shows login form',
    );
    expect(
      parsed.dynos[0]?.jobs[0]?.assertions[0]?.display?.children[0]?.passed,
    ).toBe(false);
  });

  it('accepts empty verify output matcher strings only', () => {
    const payload = validPayload();
    payload.dynos[0]!.jobs[0]!.assertions[0]!.definition = {
      type: 'verify.command',
      command: 'pnpm test',
      stdout: {equals: ''},
      stderr: {equals: ''},
    };

    const parsed = RunUploadV2.parse(payload);

    expect(parsed.dynos[0]!.jobs[0]!.assertions[0]!.definition).toMatchObject({
      stdout: {equals: ''},
      stderr: {equals: ''},
    });

    payload.dynos[0]!.jobs[0]!.assertions[0]!.definition = {
      type: 'tool.called',
      tool: 'shell',
      command: {includes: ''},
    };

    expect(() => RunUploadV2.parse(payload)).toThrow();
  });

  it('accepts full anyOf branch definitions', () => {
    const payload = validPayload();
    payload.dynos[0]!.jobs[0]!.assertions[0]!.definition = {
      type: 'anyOf',
      steps: [
        {type: 'artifact.exists', path: 'report.json'},
        {type: 'http.called', endpointId: 'upload', status: 201},
        {type: 'transcript.contains', text: 'uploaded'},
        {type: 'skill.referenced', skill: 'release'},
      ],
    };

    expect(RunUploadV2.safeParse(payload).success).toBe(true);
  });

  it('rejects unknown fields at every payload level', () => {
    const payload = validPayload();
    const dyno = validDyno();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        transcript: [{role: 'assistant', content: 'secret'}],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [{...dyno, sourceText: 'secret'}],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [{...dyno.jobs[0]!, workDir: '/tmp/dynobox-secret'}],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [
              {
                ...dyno.jobs[0]!,
                assertions: [
                  {
                    ...dyno.jobs[0]!.assertions[0]!,
                    evidence: {raw: 'tool input'},
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects oversized payload shapes', () => {
    const payload = validPayload();
    const dyno = validDyno();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: Array.from({length: RUN_UPLOAD_LIMITS.dynos + 1}, () => dyno),
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: Array.from(
              {length: RUN_UPLOAD_LIMITS.jobsPerDyno + 1},
              () => dyno.jobs[0]!,
            ),
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [
              {
                ...dyno.jobs[0]!,
                assertions: Array.from(
                  {length: RUN_UPLOAD_LIMITS.assertionsPerJob + 1},
                  () => dyno.jobs[0]!.assertions[0]!,
                ),
              },
            ],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [
              {
                ...dyno.jobs[0]!,
                assertions: [
                  {
                    ...dyno.jobs[0]!.assertions[0]!,
                    message: 'x'.repeat(
                      RUN_UPLOAD_LIMITS.assertionMessageLength + 1,
                    ),
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects nested assertion definition steps', () => {
    const payload = validPayload();

    payload.dynos[0]!.jobs[0]!.assertions[0]!.definition = {
      type: 'anyOf',
      steps: [
        {
          type: 'anyOf',
          steps: [{type: 'tool.called', tool: 'shell'}],
        } as never,
      ],
    };

    expect(() => RunUploadV2.parse(payload)).toThrow();
  });

  it('requires display fields for runs, dynos, jobs, and assertions', () => {
    const payload = validPayload();
    const dyno = validDyno();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        totals: {...payload.totals, durationMs: undefined},
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [{...dyno, target: undefined}],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [
              {
                ...dyno.jobs[0]!,
                scenario: {...dyno.jobs[0]!.scenario, name: undefined},
              },
            ],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      RunUploadV2.parse({
        ...payload,
        dynos: [
          {
            ...dyno,
            jobs: [
              {
                ...dyno.jobs[0]!,
                assertions: [
                  {...dyno.jobs[0]!.assertions[0]!, label: undefined},
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('RunUploadV3', () => {
  it('accepts harness executable versions', () => {
    const parsed = RunUploadV3.parse(validV3Payload());

    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.dynos[0]?.jobs[0]?.harness.version).toBe('2.1.4');
  });

  it('accepts a null harness version when discovery is unavailable', () => {
    const payload = validV3Payload();
    payload.dynos[0]!.jobs[0]!.harness.version = null;

    expect(RunUploadV3.parse(payload).dynos[0]!.jobs[0]!.harness.version).toBe(
      null,
    );
  });

  it('requires a harness version', () => {
    const payload = validV3Payload();
    const {version: _version, ...harness} = payload.dynos[0]!.jobs[0]!.harness;
    const invalidPayload = {
      ...payload,
      dynos: payload.dynos.map((dyno) => ({
        ...dyno,
        jobs: dyno.jobs.map((job) => ({...job, harness})),
      })),
    };

    expect(RunUploadV3.safeParse(invalidPayload).success).toBe(false);
  });

  it('parses v2 and v3 uploads', () => {
    expect(RunUpload.parse(validPayload()).schemaVersion).toBe(2);
    expect(RunUpload.parse(validV3Payload()).schemaVersion).toBe(3);
  });
});
