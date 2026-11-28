import {describe, expect, it} from 'vitest';

import {evaluateHttpCalled, evaluateHttpNotCalled} from './httpAssertions.js';
import type {HttpEvent} from './types.js';

function httpEvent(overrides: Partial<HttpEvent> = {}): HttpEvent {
  return {
    endpointId: 'endpoint.test.recall',
    method: 'POST',
    url: 'https://api.past.dev/v1/recall',
    host: 'api.past.dev',
    timestamp: '2026-11-27T00:00:00.000Z',
    status: 200,
    ...overrides,
  };
}

describe('evaluateHttpCalled body matchers', () => {
  it('matches partial deep JSON fields in the request body', () => {
    const events = [
      httpEvent({
        requestBody: JSON.stringify({
          query: 'checkout timeouts',
          identity: 'sam@example.com',
          meta: {source: 'cli', version: 2},
        }),
      }),
    ];

    const pass = evaluateHttpCalled(
      {
        id: 'assertion.test.0',
        type: 'http.called',
        endpointId: 'endpoint.test.recall',
        status: 200,
        json: {identity: 'sam@example.com', meta: {source: 'cli'}},
      },
      events,
    );
    expect(pass.passed).toBe(true);
    expect(pass.evidence).toBe(events[0]);

    const fail = evaluateHttpCalled(
      {
        id: 'assertion.test.1',
        type: 'http.called',
        endpointId: 'endpoint.test.recall',
        json: {identity: 'other@example.com'},
      },
      events,
    );
    expect(fail.passed).toBe(false);
    expect(fail.message).toContain('JSON body matching');
    expect(fail.message).toContain('other@example.com');
    expect(fail.message).toContain('sam@example.com');
  });

  it('fails json matcher when request body is missing or invalid JSON', () => {
    const events = [httpEvent({requestBody: 'not json'}), httpEvent()];

    const result = evaluateHttpCalled(
      {
        id: 'assertion.test.2',
        type: 'http.called',
        endpointId: 'endpoint.test.recall',
        json: {identity: 'sam@example.com'},
      },
      events,
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('not json');
    expect(result.message).toContain('(empty)');
  });

  it('matches bodyIncludes substring in the request body', () => {
    const events = [
      httpEvent({
        endpointId: 'endpoint.test.ingest',
        requestBody: '{"note":"Migrated queue to Postgres 17"}',
      }),
    ];

    const pass = evaluateHttpCalled(
      {
        id: 'assertion.test.3',
        type: 'http.called',
        endpointId: 'endpoint.test.ingest',
        bodyIncludes: 'Postgres',
      },
      events,
    );
    expect(pass.passed).toBe(true);

    const fail = evaluateHttpCalled(
      {
        id: 'assertion.test.4',
        type: 'http.called',
        endpointId: 'endpoint.test.ingest',
        bodyIncludes: 'MySQL',
      },
      events,
    );
    expect(fail.passed).toBe(false);
    expect(fail.message).toContain('body including "MySQL"');
  });

  it('requires status and body matchers to match on the same request', () => {
    const events = [
      httpEvent({status: 500, requestBody: '{"identity":"sam@example.com"}'}),
      httpEvent({status: 200, requestBody: '{"identity":"other@example.com"}'}),
    ];

    const result = evaluateHttpCalled(
      {
        id: 'assertion.test.5',
        type: 'http.called',
        endpointId: 'endpoint.test.recall',
        status: 200,
        json: {identity: 'sam@example.com'},
      },
      events,
    );
    expect(result.passed).toBe(false);
  });
});

describe('evaluateHttpNotCalled body matchers', () => {
  it('only fails when a request matches the specified body matcher', () => {
    const events = [httpEvent({requestBody: '{"identity":"sam@example.com"}'})];

    const pass = evaluateHttpNotCalled(
      {
        id: 'assertion.test.6',
        type: 'http.notCalled',
        endpointId: 'endpoint.test.recall',
        json: {identity: 'other@example.com'},
      },
      events,
    );
    expect(pass.passed).toBe(true);

    const fail = evaluateHttpNotCalled(
      {
        id: 'assertion.test.7',
        type: 'http.notCalled',
        endpointId: 'endpoint.test.recall',
        bodyIncludes: 'sam@example.com',
      },
      events,
    );
    expect(fail.passed).toBe(false);
    expect(fail.evidence).toBe(events[0]);
    expect(fail.message).toContain('body including "sam@example.com"');
  });
});
