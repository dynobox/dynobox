import {describe, expect, it} from 'vitest';

import {httpMockResponseSchema, httpMocksSchema} from './httpMocks.js';

const handler = () => ({status: 200, json: {ok: true}});

describe('HTTP mocks', () => {
  it('accepts a static response or a handler per hostname', () => {
    const mocks = {
      'api.example.com': {handler},
      'keycheck.example-support.com': {
        response: {status: 200, headers: {'x-mock': '1'}, body: 'ok'},
      },
    };
    expect(httpMocksSchema.parse(mocks)).toEqual(mocks);
  });

  it.each([
    'https://api.example.com',
    'api.example.com:443',
    'api.example.com/v1',
    'API.example.com',
    '-api.example.com',
    '',
  ])('rejects the key %j', (host) => {
    expect(
      httpMocksSchema.safeParse({[host]: {response: {status: 200}}}).success,
    ).toBe(false);
  });

  it.each([
    {response: {status: 200}, handler},
    {responses: [{status: 200}]},
    {response: {status: 99}},
    {response: {status: 200, statusCode: 200}},
    {response: {status: 200, body: 'ok', json: {ok: true}}},
    {handler: 'not a function'},
  ])('rejects invalid config %#', (config) => {
    expect(httpMocksSchema.safeParse({'api.example.com': config}).success).toBe(
      false,
    );
  });

  it('validates handler responses with the same response schema', () => {
    expect(httpMockResponseSchema.safeParse({status: 200}).success).toBe(true);
    expect(httpMockResponseSchema.safeParse({statusCode: 200}).success).toBe(
      false,
    );
  });
});
