import type {LocalRunnerJob} from '@dynobox/runner-local';
import type {IrScenario} from '@dynobox/sdk/ir';
import {describe, expect, it} from 'vitest';

import {httpMockNodeWarning, httpMockNoProxyError} from './httpMockEnv.js';

const MOCK = {response: {status: 200}};

function job(httpMocks?: IrScenario['httpMocks']): LocalRunnerJob {
  return {
    id: 'job',
    harness: 'claude-code',
    iteration: 1,
    scenario: {
      id: 'scenario',
      name: 'scenario',
      prompt: 'prompt',
      harnesses: [{id: 'claude-code'}],
      setup: [],
      fixtures: [],
      cliMocks: {},
      endpoints: [],
      assertions: [],
      ...(httpMocks === undefined ? {} : {httpMocks}),
    },
  };
}

describe('httpMockNodeWarning', () => {
  it.each(['20.19.0', '22.20.0', '23.11.0', '24.0.0', '24.4.1'])(
    'names each mocked host once on Node %s',
    (version) => {
      const jobs = [
        job({'api.example.com': MOCK}),
        job({'api.example.com': MOCK, 'other.example.com': MOCK}),
      ];

      expect(httpMockNodeWarning(jobs, version)).toBe(
        `warning: Node ${version} does not send all requests through the HTTP mock proxy. Node programs can reach the real hosts: api.example.com, other.example.com. Use Node 24.5 or later.\n`,
      );
    },
  );

  it.each(['22.21.0', '24.5.0', '25.0.0', '26.13.1'])(
    'says nothing on Node %s',
    (version) => {
      expect(
        httpMockNodeWarning([job({'api.example.com': MOCK})], version),
      ).toBeUndefined();
    },
  );

  it('says nothing when no job mocks a host', () => {
    expect(httpMockNodeWarning([job(), job({})], '22.20.0')).toBeUndefined();
  });
});

describe('httpMockNoProxyError', () => {
  const mocked = [job({'api.example.com': MOCK})];

  it('names each NO_PROXY variable that has a non-loopback entry', () => {
    expect(
      httpMockNoProxyError(mocked, {
        NO_PROXY: 'localhost,.corp.example.com',
        no_proxy: '*',
      }),
    ).toBe(
      'HTTP mocks cannot run with NO_PROXY and no_proxy set. Clients connect directly to hosts in it, so a mocked host there would reach the real server. Clear it for this run: NO_PROXY= no_proxy= dynobox run ...',
    );
  });

  it('allows empty and loopback-only values', () => {
    expect(
      httpMockNoProxyError(mocked, {
        NO_PROXY: 'localhost, 127.0.0.1,::1',
        no_proxy: '',
      }),
    ).toBeUndefined();
  });

  it('says nothing when no job mocks a host', () => {
    expect(httpMockNoProxyError([job()], {NO_PROXY: '*'})).toBeUndefined();
  });
});
