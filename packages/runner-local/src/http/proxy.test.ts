import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {IrScenario} from '@dynobox/sdk/ir';
import {execa} from 'execa';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {type HttpCapture, startHttpCapture} from './proxy.js';

const requests: unknown[] = [];

const scenario: IrScenario = {
  id: 'scenario.http-mocks',
  name: 'http mocks',
  prompt: 'Call the API',
  harnesses: [{id: 'claude-code'}],
  setup: [],
  fixtures: [],
  cliMocks: {},
  endpoints: [],
  assertions: [],
  httpMocks: {
    'api.example.test': {
      handler: (request) => {
        requests.push(request);
        if (request.path === '/throws') throw new Error('boom');
        if (request.path === '/invalid')
          return {statusCode: 200} as unknown as {status: number};
        return {status: 201, json: {path: request.path, got: request.body}};
      },
    },
    'static.example.test': {
      response: {status: 418, headers: {'x-mock': 'yes'}, body: 'teapot'},
    },
  },
};

let home: string;
let originalHome: string | undefined;
let capture: HttpCapture;

// curl sends CONNECT through the proxy, so the .test hosts never need DNS.
async function curl(...args: string[]) {
  const result = await execa(
    'curl',
    ['-sS', '-i', '--proxy', capture.env.HTTPS_PROXY!, ...args],
    {env: {CURL_CA_BUNDLE: capture.env.CURL_CA_BUNDLE!}, reject: false},
  );
  return result.stdout;
}

describe('startHttpCapture with HTTP mocks', () => {
  beforeAll(async () => {
    // ensureDynoboxCA writes to ~/.dynobox; keep the test CA out of the real home.
    originalHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'dynobox-http-mocks-'));
    process.env.HOME = home;
    capture = (await startHttpCapture(scenario, '/work/dir'))!;
  });

  afterAll(async () => {
    await capture?.stop();
    process.env.HOME = originalHome;
    await rm(home, {recursive: true, force: true});
  });

  it('sets the proxy env, with Node fetch opted in and a full CA bundle', () => {
    expect(capture.env).toMatchObject({
      HTTPS_PROXY: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: join(home, '.dynobox', 'ca.pem'),
      SSL_CERT_FILE: join(home, '.dynobox', 'ca-bundle.pem'),
      CURL_CA_BUNDLE: join(home, '.dynobox', 'ca-bundle.pem'),
    });
  });

  it('answers HTTPS requests from the handler, with the job workDir', async () => {
    const output = await curl(
      '-X',
      'POST',
      '--data',
      'hello',
      'https://api.example.test/v1/recall?limit=2',
    );

    expect(output).toContain('HTTP/1.1 201');
    expect(output).toContain('{"path":"/v1/recall","got":"hello"}');
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/v1/recall?limit=2',
      path: '/v1/recall',
      body: 'hello',
      workDir: '/work/dir',
    });
    expect(capture.events.at(-1)).toMatchObject({
      method: 'POST',
      host: 'api.example.test',
      status: 201,
    });
  });

  it('answers plain HTTP requests from a static response', async () => {
    const output = await curl('http://static.example.test/anything');

    expect(output).toContain('HTTP/1.1 418');
    expect(output.toLowerCase()).toContain('x-mock: yes');
    expect(output).toContain('teapot');
  });

  it('records handler errors and invalid responses as failures', async () => {
    expect(await curl('https://api.example.test/throws')).toContain(
      'HTTP/1.1 500',
    );
    expect(await curl('https://api.example.test/invalid')).toContain(
      'HTTP/1.1 500',
    );
    expect(capture.failures).toEqual([
      'HTTP mock for api.example.test failed on GET https://api.example.test/throws: boom',
      expect.stringMatching(
        /^HTTP mock for api\.example\.test failed on GET https:\/\/api\.example\.test\/invalid: invalid response:/,
      ),
    ]);
  });
});
