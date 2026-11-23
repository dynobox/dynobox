import {describe, expect, it} from 'vitest';

import {
  RUN_UPLOAD_LIMITS,
  RUN_UPLOAD_SCHEMA_VERSION,
  RUN_UPLOAD_V2_SCHEMA_VERSION,
  RUN_UPLOAD_V3_SCHEMA_VERSION,
  RUN_UPLOAD_V4_SCHEMA_VERSION,
  RUN_UPLOAD_V5_SCHEMA_VERSION,
  RUN_UPLOAD_V6_SCHEMA_VERSION,
  RUN_UPLOAD_V7_SCHEMA_VERSION,
  RunUpload,
  type RunUploadCreateInputV2,
  type RunUploadCreateInputV3,
  type RunUploadCreateInputV4,
  type RunUploadCreateInputV5,
  type RunUploadCreateInputV6,
  type RunUploadCreateInputV7,
  type RunUploadCreateInputV8,
  RunUploadV2,
  RunUploadV3,
  RunUploadV4,
  RunUploadV5,
  RunUploadV6,
  RunUploadV7,
  RunUploadV8,
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
    schemaVersion: RUN_UPLOAD_V3_SCHEMA_VERSION,
    dynos: payload.dynos.map((dyno) => ({
      ...dyno,
      jobs: dyno.jobs.map((job) => ({
        ...job,
        harness: {...job.harness, version: '2.1.4'},
      })),
    })),
  };
}

function validV4Payload(): RunUploadCreateInputV4 {
  return {
    ...validV3Payload(),
    schemaVersion: RUN_UPLOAD_V4_SCHEMA_VERSION,
    git: {
      commit: 'abc123',
      branch: 'main',
      userName: 'Example User',
      userEmail: 'user@example.com',
      dirty: true,
    },
  };
}

function validV5Payload(): RunUploadCreateInputV5 {
  const payload = validV4Payload();
  return {
    ...payload,
    schemaVersion: RUN_UPLOAD_V5_SCHEMA_VERSION,
    dynos: payload.dynos.map((dyno) => ({
      ...dyno,
      jobs: dyno.jobs.map((job) => ({
        ...job,
        assertions: job.assertions.map((assertion) => ({
          ...assertion,
          type: 'mcp.called',
          definition: {type: 'mcp.called', server: 'github', tool: 'get_issue'},
        })),
        mcp: {
          ready: true,
          finalized: true,
          failures: ['exhausted'],
          callCount: 2,
          calls: [
            {
              sequence: 0,
              server: 'github',
              tool: 'get_issue',
              category: 'success',
            },
            {
              sequence: 1,
              server: 'github',
              tool: 'get_issue',
              category: 'exhausted',
            },
          ],
        },
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

  it('accepts only positive matched anyOf branch indexes', () => {
    const payload = validPayload();
    const assertion = payload.dynos[0]!.jobs[0]!.assertions[0]!;

    assertion.evidence = {matchedBranchIndex: 2};
    expect(
      RunUploadV2.parse(payload).dynos[0]!.jobs[0]!.assertions[0]!.evidence,
    ).toMatchObject({matchedBranchIndex: 2});

    assertion.evidence = {matchedBranchIndex: 0};
    expect(() => RunUploadV2.parse(payload)).toThrow();

    assertion.evidence = {matchedBranchIndex: -1};
    expect(() => RunUploadV2.parse(payload)).toThrow();
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

describe('RunUploadV4', () => {
  it('accepts current Git metadata', () => {
    const parsed = RunUploadV4.parse(validV4Payload());

    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.git).toEqual({
      commit: 'abc123',
      branch: 'main',
      userName: 'Example User',
      userEmail: 'user@example.com',
      dirty: true,
    });
  });

  it('accepts unavailable Git metadata', () => {
    const payload = validV4Payload();
    payload.git = null;

    expect(RunUploadV4.parse(payload).git).toBeNull();
  });

  it('parses all supported upload versions', () => {
    expect(RunUpload.parse(validPayload()).schemaVersion).toBe(2);
    expect(RunUpload.parse(validV3Payload()).schemaVersion).toBe(3);
    expect(RunUpload.parse(validV4Payload()).schemaVersion).toBe(4);
  });
});

describe('RunUploadV5', () => {
  it('accepts MCP assertion definitions and job mock summaries', () => {
    const parsed = RunUploadV5.parse(validV5Payload());
    const job = parsed.dynos[0]!.jobs[0]!;

    expect(parsed.schemaVersion).toBe(5);
    expect(job.assertions[0]!.definition).toEqual({
      type: 'mcp.called',
      server: 'github',
      tool: 'get_issue',
    });
    expect(job.mcp?.callCount).toBe(2);
    expect(job.mcp?.calls[1]?.category).toBe('exhausted');
  });

  it('accepts jobs without MCP mocks', () => {
    const payload = validV5Payload();
    delete payload.dynos[0]!.jobs[0]!.mcp;

    expect(RunUploadV5.parse(payload).dynos[0]!.jobs[0]!.mcp).toBeUndefined();
  });

  it('rejects MCP call inputs', () => {
    const payload = validV5Payload();
    payload.dynos[0]!.jobs[0]!.mcp!.calls[0] = {
      ...payload.dynos[0]!.jobs[0]!.mcp!.calls[0]!,
      input: {id: 1},
    } as never;

    expect(RunUploadV5.safeParse(payload).success).toBe(false);
  });

  it('caps uploaded MCP calls', () => {
    const payload = validV5Payload();
    const mcp = payload.dynos[0]!.jobs[0]!.mcp!;
    mcp.calls = Array.from(
      {length: RUN_UPLOAD_LIMITS.mcpCallsPerJob + 1},
      (_, sequence) => ({
        sequence,
        server: 'github',
        tool: 'get_issue',
        category: 'success',
      }),
    );

    expect(RunUploadV5.safeParse(payload).success).toBe(false);
  });

  it('rejects job MCP summaries on v4 uploads', () => {
    const payload = validV5Payload();

    expect(RunUploadV4.safeParse({...payload, schemaVersion: 4}).success).toBe(
      false,
    );
  });

  it('parses all supported upload versions', () => {
    expect(RunUpload.parse(validV4Payload()).schemaVersion).toBe(4);
    expect(RunUpload.parse(validV5Payload()).schemaVersion).toBe(5);
  });
});

function validV6Payload(): RunUploadCreateInputV6 {
  const payload = validV5Payload();
  return {
    ...payload,
    schemaVersion: RUN_UPLOAD_V6_SCHEMA_VERSION,
    git: {...payload.git!, repository: 'github.com/dynobox/dynobox'},
  };
}

describe('RunUploadV6', () => {
  it('accepts the git repository', () => {
    const parsed = RunUploadV6.parse(validV6Payload());

    expect(parsed.schemaVersion).toBe(6);
    expect(parsed.git?.repository).toBe('github.com/dynobox/dynobox');
  });

  it('accepts a missing or null repository', () => {
    const payload = validV6Payload();
    expect(
      RunUploadV6.parse({...payload, git: {...payload.git!, repository: null}})
        .git?.repository,
    ).toBeNull();

    delete payload.git!.repository;
    expect(RunUploadV6.parse(payload).git?.repository).toBeUndefined();
  });

  it.each([
    'https://github.com/dynobox/dynobox',
    'git@github.com:dynobox/dynobox',
    'user:token@github.com/dynobox/dynobox',
    'github.com:8443/dynobox/dynobox',
    'github.com',
    'github.com/dynobox/dyno box',
  ])('rejects the repository %s', (repository) => {
    const payload = validV6Payload();

    expect(
      RunUploadV6.safeParse({...payload, git: {...payload.git!, repository}})
        .success,
    ).toBe(false);
  });

  it('rejects the repository on v5 uploads', () => {
    const payload = validV6Payload();

    expect(RunUploadV5.safeParse({...payload, schemaVersion: 5}).success).toBe(
      false,
    );
  });

  it('parses all supported upload versions', () => {
    expect(RunUpload.parse(validV5Payload()).schemaVersion).toBe(5);
    expect(RunUpload.parse(validV6Payload()).schemaVersion).toBe(6);
  });
});

function validV7Payload(): RunUploadCreateInputV7 {
  const payload = validV6Payload();
  const job = payload.dynos[0]!.jobs[0]!;
  return {
    ...payload,
    schemaVersion: RUN_UPLOAD_V7_SCHEMA_VERSION,
    dynos: [
      {
        ...payload.dynos[0]!,
        jobs: [
          {
            ...job,
            conversation: {
              user: {kind: 'persona', harness: 'codex', model: 'gpt-6-luna'},
              maxTurns: 4,
              turns: [{durationMs: 1200}, {durationMs: 800}],
            },
          },
        ],
      },
    ],
  };
}

describe('RunUploadV7', () => {
  it('accepts a persona conversation summary', () => {
    const parsed = RunUploadV7.parse(validV7Payload());

    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.dynos[0]!.jobs[0]!.conversation).toEqual({
      user: {kind: 'persona', harness: 'codex', model: 'gpt-6-luna'},
      maxTurns: 4,
      turns: [{durationMs: 1200}, {durationMs: 800}],
    });
  });

  it('accepts scripted users and jobs without a conversation', () => {
    const payload = validV7Payload();
    const job = payload.dynos[0]!.jobs[0]!;
    job.conversation = {user: {kind: 'scripted'}, maxTurns: 2, turns: []};
    expect(RunUploadV7.safeParse(payload).success).toBe(true);

    delete job.conversation;
    expect(
      RunUploadV7.parse(payload).dynos[0]!.jobs[0]!.conversation,
    ).toBeUndefined();
  });

  it.each([
    ['a message', {turns: [{durationMs: 1, prompt: 'Add a table.'}]}],
    ['persona text', {user: {kind: 'scripted', persona: 'Someone.'}}],
    ['an unknown user kind', {user: {kind: 'robot'}}],
    ['too many turns', {maxTurns: RUN_UPLOAD_LIMITS.conversationTurns + 1}],
    [
      'more turn records than the limit',
      {
        turns: Array.from(
          {length: RUN_UPLOAD_LIMITS.conversationTurns + 1},
          () => ({durationMs: 1}),
        ),
      },
    ],
  ])('rejects %s', (_label, change) => {
    const payload = validV7Payload();
    const job = payload.dynos[0]!.jobs[0]!;
    job.conversation = {...job.conversation!, ...change} as never;

    expect(RunUploadV7.safeParse(payload).success).toBe(false);
  });

  it('rejects conversations on v6 uploads', () => {
    const payload = validV7Payload();

    expect(RunUploadV6.safeParse({...payload, schemaVersion: 6}).success).toBe(
      false,
    );
  });

  it('parses all supported upload versions', () => {
    expect(RunUpload.parse(validV6Payload()).schemaVersion).toBe(6);
    expect(RunUpload.parse(validV7Payload()).schemaVersion).toBe(7);
  });
});

function validV8Payload(): RunUploadCreateInputV8 {
  const payload = validV7Payload();
  const job = payload.dynos[0]!.jobs[0]!;
  return {
    ...payload,
    schemaVersion: RUN_UPLOAD_SCHEMA_VERSION,
    dynos: [
      {
        ...payload.dynos[0]!,
        jobs: [
          {
            ...job,
            http: {
              hosts: ['api.example.com'],
              callCount: 2,
              calls: [
                {
                  sequence: 1,
                  method: 'POST',
                  host: 'api.example.com',
                  path: '/v1/items',
                  status: 201,
                },
                {
                  sequence: 2,
                  method: 'GET',
                  host: 'api.example.com',
                  path: '/v1/items/42',
                  status: null,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('RunUploadV8', () => {
  it('accepts an HTTP mock summary', () => {
    const parsed = RunUploadV8.parse(validV8Payload());

    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.dynos[0]!.jobs[0]!.http?.calls).toHaveLength(2);
  });

  it('accepts jobs without HTTP mocks', () => {
    const payload = validV8Payload();
    delete payload.dynos[0]!.jobs[0]!.http;

    expect(RunUploadV8.parse(payload).dynos[0]!.jobs[0]!.http).toBeUndefined();
  });

  it.each([
    ['a request body', {body: '{"secret":true}'}],
    ['a query string field', {query: 'token=abc'}],
    ['an invalid status', {status: 42}],
    ['an empty path', {path: ''}],
  ])('rejects a call with %s', (_label, change) => {
    const payload = validV8Payload();
    const http = payload.dynos[0]!.jobs[0]!.http!;
    http.calls[0] = {...http.calls[0]!, ...change} as never;

    expect(RunUploadV8.safeParse(payload).success).toBe(false);
  });

  it('rejects more calls than the limit', () => {
    const payload = validV8Payload();
    const http = payload.dynos[0]!.jobs[0]!.http!;
    http.calls = Array.from(
      {length: RUN_UPLOAD_LIMITS.httpCallsPerJob + 1},
      (_, index) => ({...http.calls[0]!, sequence: index + 1}),
    );

    expect(RunUploadV8.safeParse(payload).success).toBe(false);
  });

  it('rejects HTTP summaries on v7 uploads', () => {
    expect(
      RunUploadV7.safeParse({...validV8Payload(), schemaVersion: 7}).success,
    ).toBe(false);
  });

  it('parses all supported upload versions', () => {
    expect(RunUpload.parse(validV7Payload()).schemaVersion).toBe(7);
    expect(RunUpload.parse(validV8Payload()).schemaVersion).toBe(8);
  });
});
