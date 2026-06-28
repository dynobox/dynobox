import type {AssertionResult} from '@dynobox/evaluators';
import type {HttpEvent, ToolEvent} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {
  assertionResultEvidence,
  formatHttpEvent,
  isHttpEvent,
  isToolEvent,
} from './evidence.js';

describe('assertionResultEvidence', () => {
  it('returns evidence for a matching assertion id', () => {
    const evidence = {kind: 'example'};
    const results: AssertionResult[] = [
      {
        assertionId: 'assertion-1',
        kind: 'tool.called',
        passed: true,
        message: 'passed',
        evidence,
      },
    ];

    expect(assertionResultEvidence(results, 'assertion-1')).toBe(evidence);
  });

  it('returns undefined when no assertion result matches', () => {
    expect(assertionResultEvidence([], 'missing')).toBeUndefined();
  });
});

describe('isToolEvent', () => {
  it('accepts tool event shaped values', () => {
    const event: ToolEvent = {
      kind: 'read_file',
      rawName: 'Read',
      input: {file_path: 'README.md'},
    };

    expect(isToolEvent(event)).toBe(true);
  });

  it('rejects non-tool event shaped values', () => {
    expect(isToolEvent({kind: 'read_file'})).toBe(false);
  });
});

describe('isHttpEvent', () => {
  it('accepts HTTP event shaped values', () => {
    const event: HttpEvent = {
      endpointId: null,
      method: 'GET',
      url: 'https://example.test',
      host: 'example.test',
      timestamp: '2026-06-27T00:00:00.000Z',
    };

    expect(isHttpEvent(event)).toBe(true);
  });

  it('rejects non-HTTP event shaped values', () => {
    expect(isHttpEvent({method: 'GET'})).toBe(false);
  });
});

describe('formatHttpEvent', () => {
  it('formats HTTP events with optional status', () => {
    expect(
      formatHttpEvent({
        endpointId: 'api',
        method: 'POST',
        url: 'https://example.test/api',
        host: 'example.test',
        timestamp: '2026-06-27T00:00:00.000Z',
        status: 201,
      }),
    ).toBe('POST https://example.test/api -> 201');

    expect(
      formatHttpEvent({
        endpointId: 'api',
        method: 'POST',
        url: 'https://example.test/api',
        host: 'example.test',
        timestamp: '2026-06-27T00:00:00.000Z',
      }),
    ).toBe('POST https://example.test/api');
  });
});
