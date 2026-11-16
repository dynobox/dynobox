import {describe, expect, it} from 'vitest';

import {
  TELEMETRY_LIMITS,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryBatch,
  type TelemetryBatchV1,
} from './telemetry.js';

const runId = '6f1c1e3a-8f2b-4c55-9a4e-2d7b1f0c9e11';

function validBatch(): TelemetryBatchV1 {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    context: {
      installId: '0b6f8d0e-3c1a-4f7e-8b2d-5a9c4e1f7d23',
      cliVersion: '0.18.0',
      os: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.20.0',
      ci: false,
    },
    events: [
      {
        type: 'command',
        command: 'run',
        exitCode: 0,
        durationMs: 371_000,
        errorCategory: null,
        firstRun: false,
      },
      {
        type: 'run',
        runId,
        dynos: 7,
        scenarios: 12,
        jobs: 57,
        iterations: 1,
        passed: true,
        configFormats: ['js'],
        features: ['save_run', 'cli_mocks'],
      },
      {
        type: 'harness_run',
        runId,
        harness: 'claude-code',
        harnessVersion: '2.1.323',
        model: 'haiku',
        jobs: 12,
        passed: 12,
        assertionFailed: 0,
        harnessFailed: 0,
        setupFailed: 0,
        timedOut: 0,
        wallMs: 187_000,
        reportedMs: 61_000,
        unknownToolEvents: 0,
      },
    ],
  };
}

describe('TelemetryBatch', () => {
  it('accepts a batch with every event type', () => {
    expect(TelemetryBatch.parse(validBatch())).toEqual(validBatch());
  });

  it('accepts identifiers the current CLI does not send yet', () => {
    const batch = validBatch();
    batch.events[0] = {
      type: 'command',
      command: 'telemetry',
      exitCode: 1,
      durationMs: 12,
      errorCategory: 'rate_limited',
      firstRun: true,
    };
    expect(TelemetryBatch.safeParse(batch).success).toBe(true);
  });

  it('drops unknown fields so newer CLIs still validate', () => {
    const batch = {
      ...validBatch(),
      context: {...validBatch().context, shell: 'zsh'},
    };
    const parsed = TelemetryBatch.parse(batch);
    expect(parsed.context).not.toHaveProperty('shell');
  });

  it.each([
    ['an unknown schema version', {schemaVersion: 2}],
    ['an empty batch', {events: []}],
    [
      'too many events',
      {
        events: Array.from(
          {length: TELEMETRY_LIMITS.eventsPerBatch + 1},
          () => validBatch().events[0],
        ),
      },
    ],
    [
      'an install id that is not a UUID',
      {context: {...validBatch().context, installId: 'user@example.com'}},
    ],
  ])('rejects %s', (_label, override) => {
    expect(
      TelemetryBatch.safeParse({...validBatch(), ...override}).success,
    ).toBe(false);
  });

  it('rejects identifiers that could carry free text', () => {
    const batch = validBatch();
    batch.events[1] = {
      ...(batch.events[1] as Extract<
        TelemetryBatchV1['events'][number],
        {type: 'run'}
      >),
      features: ['save run with /Users/me/project'],
    };
    expect(TelemetryBatch.safeParse(batch).success).toBe(false);
  });
});
