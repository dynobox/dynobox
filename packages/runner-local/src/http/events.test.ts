import type {IrScenario} from '@dynobox/sdk/ir';
import {describe, expect, it} from 'vitest';

import {
  buildHttpRoutes,
  createHttpEvent,
  matchHttpEndpointId,
  scenarioNeedsHttpCapture,
} from './events.js';

const scenario: IrScenario = {
  id: 'scenario.http',
  name: 'http',
  prompt: 'Fetch the user endpoint',
  harnesses: [{id: 'claude-code'}],
  setup: [],
  fixtures: [],
  endpoints: [
    {
      id: 'endpoint.http.getUser',
      key: 'getUser',
      method: 'GET',
      url: 'https://api.example.test/user',
    },
    {
      id: 'endpoint.http.deleteUser',
      key: 'deleteUser',
      method: 'DELETE',
      url: 'https://api.example.test/user',
    },
  ],
  assertions: [
    {
      id: 'assertion.http.0',
      type: 'http.called',
      endpointId: 'endpoint.http.getUser',
      status: 200,
    },
  ],
};

describe('HTTP event helpers', () => {
  it('detects scenarios that need HTTP capture', () => {
    expect(scenarioNeedsHttpCapture(scenario)).toBe(true);
    expect(
      scenarioNeedsHttpCapture({
        ...scenario,
        assertions: [
          {id: 'assertion.http.0', type: 'tool.called', tool: 'shell'},
        ],
      }),
    ).toBe(false);
  });

  it('builds routes only for asserted endpoints', () => {
    expect(buildHttpRoutes(scenario)).toEqual([
      {
        endpointId: 'endpoint.http.getUser',
        method: 'GET',
        url: 'https://api.example.test/user',
        host: 'api.example.test',
      },
    ]);
  });

  it('matches endpoint ids by exact method and URL', () => {
    const routes = buildHttpRoutes(scenario);

    expect(
      matchHttpEndpointId(routes, 'GET', 'https://api.example.test/user'),
    ).toBe('endpoint.http.getUser');
    expect(
      matchHttpEndpointId(routes, 'POST', 'https://api.example.test/user'),
    ).toBeNull();
  });

  it('creates HTTP events with endpoint ids and status', () => {
    const event = createHttpEvent({
      routes: buildHttpRoutes(scenario),
      method: 'get',
      url: 'https://api.example.test/user',
      status: 200,
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(event).toEqual({
      endpointId: 'endpoint.http.getUser',
      method: 'GET',
      url: 'https://api.example.test/user',
      host: 'api.example.test',
      status: 200,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });
});
